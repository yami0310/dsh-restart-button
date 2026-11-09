/**
 * dsh-restart-button · 宿主半边
 * ============================================================================
 * 只做一件事：给网页半边的按钮提供一个 POST 接口，收到就把「重启 DSH」交给
 * 一个**完全脱离本进程**的助手去做，然后立刻回 200。
 *
 * 为什么必须交给外部助手：
 *   重启 = 杀掉当前进程再拉起一个新的。杀掉自己之后代码就不存在了，所以
 *   「杀 + 拉起 + 等它起来」这三步只能由别的进程执行。
 *
 * 为什么助手不能由本进程直接 spawn：
 *   DSH 的进程全都待在一个 job object 里，且该 job 带 KILL_ON_JOB_CLOSE、
 *   不允许 breakaway（实测 LimitFlags=0x2000，BREAKAWAY_OK=False）。
 *   直接 spawn 出来的子进程会继承这个 job —— 一旦 DSH 被杀、job 关闭，
 *   助手跟着一起死，永远走不到「拉起新实例」那一步。
 *   上一次手写脚本的日志断在 "force killing" 就是这个原因。
 *
 *   所以走这条路：
 *     宿主 → schtasks /run → 任务计划服务 → wscript → node helper
 *   任务计划服务是独立进程，助手不继承 DSH 的 job，也不会随 DSH 一起死。
 *   wscript 是 GUI 子系统程序，用它拉起 node 不会有控制台窗口闪出来。
 *
 * 为什么拉起新实例前必须删掉 ELECTRON_RUN_AS_NODE：
 *   本宿主进程是 Electron 主进程用 `ELECTRON_RUN_AS_NODE=1` 拉起来的「当 node 用」
 *   的子进程。若原样传给新实例，新实例也会以 node 模式运行（没有窗口、不启
 *   web server），表现为「重启后什么都没发生」。
 * ============================================================================
 */

import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'restart-button'

/** 需要 webServer 才挂得上路由；没有它这个插件什么也不做。 */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, 'helper.mjs')
const ROUTE = '/api/dsh-restart-button'

const DATA_DIR = join(homedir(), '.dsh')
const LAUNCH_VBS = join(DATA_DIR, 'restart-button.launch.vbs')
const LOG = join(DATA_DIR, 'restart-button.log')
const TASK_NAME = 'DSHRestartButton'

/** 一次只允许一个重启在进行，避免连点两下拉起两个新实例。 */
let busy = false

/**
 * 这次「忙」是从什么时候开始的。
 *
 * 为什么需要它：`busy` 只有在新进程起来、本进程被杀之后才「自然消失」。
 * 可重启是会失败的（助手拒绝访问、找不到 exe、计划任务建不起来……），
 * 失败时本进程还活着，`busy` 就永远停在 true —— 之后再点按钮一律 409
 * 「已经有一次重启在进行」，只能重启 DSH 才能恢复。实测踩过这个坑。
 *
 * 所以按时间兜底：本进程既然还活着，说明重启没成功；超过这个时限就把
 * 标志放掉，允许重试。成功的重启根本走不到这一步（进程已经没了）。
 */
const BUSY_TIMEOUT_MS = 90_000
let busySince = 0

function isBusy() {
  if (!busy) return false
  if (Date.now() - busySince < BUSY_TIMEOUT_MS) return true
  // 超时了还活着 = 上次重启没成功，放行
  busy = false
  busySince = 0
  return false
}

/**
 * 找真正的 node.exe。
 *
 * 不能直接用 process.execPath —— 那是 `DeepSeek Harness.exe`（Electron），
 * 拿它跑 .mjs 会再起一个 Electron，而不是 node。
 */
function findNode() {
  const candidates = [
    // ① 应用自带的内置 node：Electron 安装目录旁边
    join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    // ② 便携安装：DSH 把运行时放在用户目录下
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    // ③ 安装位置不标准时，用这个环境变量直接指定
    process.env.DSH_RESTART_NODE ?? '',
  ].filter((candidate) => candidate !== '')
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 权限/路径怪问题：试下一个 */
    }
  }
  return null
}

/**
 * 只接受本机同源请求。
 *
 * 这个接口能让整台机器上的 DSH 关掉，不能只靠「猜不到 URL」当防护：
 * 浏览器里任何一个页面都能往 127.0.0.1 发 POST（跨站也能发，只是读不到回包），
 * 所以必须校验 Host 是回环地址、且 Origin（若有）与 Host 完全一致。
 */
function sameOrigin(req) {
  const host = String(req.headers.host || '')
  if (!host) return false
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const origin = String(req.headers.origin || '')
  if (!origin) return true // 非浏览器发起（本机脚本 / 宿主内部）
  try {
    return String(new URL(origin).host || '').toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    /* 连接已断：无所谓 */
  }
}

/** 跑一个命令，永不抛。 */
function run(file, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout || ''), stderr: String(stderr || ''), error })
    })
  })
}

/**
 * 写启动脚本。
 *
 * 纯 ASCII —— PowerShell/WSH 在中文系统上按 ANSI 读文件，非 ASCII 会出乱码。
 * 脚本内容：用 WScript.Shell.Run 以「隐藏窗口」方式启动 node 助手。
 */
function writeLauncher(node) {
  // 第二个参数是「要重启哪个 exe」，由助手原样拿去拉起新实例。
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run """' + node + '"" ""' + HELPER + '"" ""' + process.execPath + '""", 0, False',
    '',
  ].join('\r\n')
  writeFileSync(LAUNCH_VBS, vbs, 'latin1')
}

/**
 * 计划任务是否已存在、且**以最高权限运行**。
 *
 * 只查「存在」是不够的：早期版本建的任务没有 /RL HIGHEST，如果直接复用，
 * 助手会以普通权限运行，而 DSH 是管理员权限启动的 —— `taskkill` 会被
 * 「拒绝访问」打回来，重启就永远失败。实测对比：
 *   普通权限任务：`错误: 无法终止 PID 为 xxx 的进程。原因: 拒绝访问。`
 *   /RL HIGHEST：`成功: 已终止 PID 为 xxx 的进程。`
 *
 * `/query /fo list /v` 的输出里没有权限字段，只能读 XML 的
 * `<RunLevel>HighestAvailable</RunLevel>`。级别不对就当任务不存在，下面会 /f 重建。
 */
async function taskExists() {
  const result = await run('schtasks.exe', ['/query', '/tn', TASK_NAME, '/xml'])
  if (!result.ok) return false
  return /<RunLevel>\s*HighestAvailable\s*<\/RunLevel>/i.test(result.stdout)
}

/** 建任务时用一个「总是在未来」的时刻：现在 + 5 分钟。 */
function futureStartTime() {
  const t = new Date(Date.now() + 5 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/**
 * 注册计划任务（幂等）。
 *
 * 任务动作是 wscript 跑那个 .vbs —— wscript 属于 GUI 子系统，不会开控制台；
 * 任务由任务计划服务启动，因此不继承 DSH 的 job object。
 *
 * **必须带 /RL HIGHEST**：DSH 通常是以管理员权限启动的（`IsInRole(Administrator)`
 * 为 True）。普通权限的计划任务去 `taskkill` 一个管理员进程会被拒绝访问，
 * 于是「点了按钮但什么都没发生」。加了之后任务以最高可用权限运行，才杀得动。
 * 相应地，它拉起的新 DSH 实例也是管理员权限 —— 与原来的实例一致。
 */
async function ensureTask() {
  const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  if (!existsSync(wscript)) return { ok: false, error: '找不到 wscript.exe' }

  if (await taskExists()) return { ok: true }

  const action = `"${wscript}" "${LAUNCH_VBS}"`
  const result = await run('schtasks.exe', [
    '/create', '/tn', TASK_NAME, '/tr', action,
    '/sc', 'once', '/st', futureStartTime(), '/RL', 'HIGHEST', '/f',
  ])
  if (!result.ok) {
    return { ok: false, error: (result.stderr || result.stdout || 'schtasks 创建任务失败').trim() }
  }
  return { ok: true }
}

async function trigger() {
  const node = findNode()
  if (node === null) return { ok: false, error: '找不到内置 node.exe，无法启动重启助手' }
  if (!existsSync(HELPER)) return { ok: false, error: '缺少助手脚本 ' + HELPER }

  try {
    writeLauncher(node)
  } catch (error) {
    return { ok: false, error: '写启动脚本失败：' + (error?.message ?? String(error)) }
  }

  const task = await ensureTask()
  if (!task.ok) return task

  const started = await run('schtasks.exe', ['/run', '/tn', TASK_NAME])
  if (!started.ok) {
    return { ok: false, error: (started.stderr || started.stdout || 'schtasks /run 失败').trim() }
  }
  return { ok: true }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          if (!sameOrigin(req)) {
            sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
            return
          }

          const path = req.url.split('?')[0]

          if (req.method === 'GET' && path === ROUTE + '/status') {
            sendJson(res, 200, { ok: true, busy: isBusy() })
            return
          }

          if (req.method !== 'POST' || path !== ROUTE + '/restart') {
            sendJson(res, 404, { ok: false, error: 'unknown route' })
            return
          }

          if (isBusy()) {
            sendJson(res, 409, { ok: false, error: '已经有一次重启在进行' })
            return
          }

          busy = true
          busySince = Date.now()

          // 先把助手拉起来，确认真的拉起来了再回 200 ——
          // 反过来的话，拉起失败用户只会看到页面断开却什么都没发生。
          const result = await trigger()
          if (!result.ok) {
            busy = false
            busySince = 0
            sendJson(res, 500, { ok: false, error: result.error })
            return
          }

          sendJson(res, 200, { ok: true, message: '正在重启' })
        },
      }),
    'dsh-restart-button: /api/dsh-restart-button 路由',
  )

  // 插件加载时就把启动脚本写好，第一次点按钮时少一步出错的机会。
  try {
    const node = findNode()
    if (node !== null) writeLauncher(node)
  } catch {
    /* 写不了就算了，点按钮时会再试 */
  }
}

export { LOG }
