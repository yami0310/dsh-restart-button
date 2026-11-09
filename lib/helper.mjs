/**
 * dsh-restart-button · 重启助手
 * ============================================================================
 * 由计划任务经 wscript 拉起（见 lib/index.js 的说明），做完
 * 「杀旧实例 → 等它退干净 → 拉起新实例 → 等它开始服务」就退出。
 *
 * 六条硬约束，每条都对应一次真实踩坑：
 *
 * 1. **按镜像名杀，绝不按进程树杀。**
 *    `taskkill /T` 会顺着父子关系把调用者自己带走。助手跑在 node.exe 里，
 *    按镜像名只杀 `DeepSeek Harness.exe`，正好绕过自己。
 *
 * 2. **先杀 GUI 主进程，再杀其余的。**
 *    这个顺序不是随便定的。DSH 主进程监听 renderer 的退出事件：
 *      window.webContents.on("render-process-gone", ...) → reportFatal(...)
 *    只要主进程还活着而 renderer 先死了，它就会弹一个错误对话框
 *    「Desktop renderer exited: killed」，还给三个按钮（退出 / 重启 /
 *    停用第三方插件）。用户点了「重启」，App 就自己又起来一份 ——
 *    于是我们看到「杀完之后冒出一批全新 PID」这种怪现象。
 *    主进程先死，就没有人来弹这个窗了。
 *
 * 3. **不能靠固定端口判断「起来了」。**
 *    DSH 每次启动监听的都是随机端口（50054 → 52583 → 58171 …）。上次手写
 *    脚本写死 50054，结果新实例早就起来了，脚本还在等那个永远不会再用的
 *    端口，最后报 "did not start listening within 80s" —— 假失败。
 *
 * 4. **也不能靠「任意一个 DSH 进程在监听」判断。**
 *    Roost 之类的插件也是 `DeepSeek Harness.exe` 进程，还固定监听 8080。
 *    只看「有没有 DSH 进程在 LISTENING」会把 8080 当成 DSH 的 web 端口，
 *    日志里写下一个错的端口号，下次排查就被它带偏。
 *    真正的宿主进程命令行带 `--expose-internals`，只有它监听的是 web 端口。
 *
 * 5. **拉起新实例前必须删掉 ELECTRON_RUN_AS_NODE。**
 *    宿主进程是 Electron 以「当 node 用」模式拉起的子进程，这个变量会一路
 *    继承。原样传给新实例，新实例也会以 node 模式运行：没有窗口、不启
 *    web server，用户看到的就是「重启之后什么都没发生」。
 *
 * 6. **全程不产生控制台窗口，但也不能把应用窗口藏起来。**
 *    助手由 wscript 以隐藏窗口方式启动；它调用的 tasklist / taskkill /
 *    netstat / powershell 全部带 windowsHide。但**拉起 DSH 本身时绝对不能
 *    带 windowsHide** —— 实测对照：同一个 exe，`windowsHide:true` 时
 *    `MainWindowHandle=0`、`IsWindowVisible=False`，窗口根本不出现；
 *    改成 false 就正常显示。这个参数是为控制台程序设计的，对 GUI 程序
 *    会把整个窗口一起藏掉，用户看到的就是「重启之后桌面什么都没有」。
 * ============================================================================
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const EXE = process.argv[2]

/**
 * 进程镜像名与不带扩展名的名字，都从传入的 exe 路径推导。
 *
 * 不在代码里写死 `DeepSeek Harness.exe`：DSH 改名、或装的是别的 Electron
 * 应用时，写死就全盘失效（而且失效得很安静 —— taskkill 找不到匹配会直接
 * 返回成功）。这里用 path.basename 取，取不到才退回默认值。
 */
const EXE_BASENAME = typeof EXE === 'string' && EXE !== '' ? basename(EXE) : ''
const IMAGE = EXE_BASENAME !== '' ? EXE_BASENAME : 'DeepSeek Harness.exe'
/** PowerShell 的 Get-Process 用不带 .exe 的名字。 */
const PROCESS_NAME = IMAGE.replace(/\.exe$/i, '')

const LOG = join(homedir(), '.dsh', 'restart-button.log')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`
  try {
    appendFileSync(LOG, line, 'utf8')
  } catch {
    /* 日志写不进去不能影响重启本身 */
  }
}

/** 跑一个命令，永远不抛。返回 stdout（失败给已捕获的部分）。 */
function run(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 25_000,
    })
  } catch (error) {
    return error?.stdout ? String(error.stdout) : ''
  }
}

/**
 * 所有 DSH 进程及其命令行与父进程。
 *
 * 命令行必须拿 —— 光看进程名分不出「GUI 主进程 / 宿主 / renderer / 插件子进程」，
 * 而这四类在这个流程里的处理完全不同。
 */
function dshProcesses() {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${IMAGE}'" | ` +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"
  const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const list = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split('|')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    list.push({ pid, ppid, cmd: parts.slice(2).join('|') })
  }
  return list
}

/**
 * 从进程列表里挑出 GUI 主进程和宿主进程。
 *
 * - **GUI 主进程**：父进程不是 DSH（是 explorer / 任务计划 / shell）。这条判据
 *   比「命令行里没有 --type=」可靠得多 —— 后者会把插件子进程也算进来
 *   （实测 `dsh-computer-use-win` 的 mcp 服务、Roost 的 `src/main.js --serve`
 *   都是无 `--type=` 的裸进程）。先杀它，见文件头第 2 条。
 * - **宿主进程**：命令行带 `--expose-internals`，它才是监听 web 端口的那一个。
 */
function classify(processes) {
  const dshPids = new Set(processes.map((p) => p.pid))
  const main = []
  const host = []
  for (const p of processes) {
    if (p.cmd.includes('--type=')) continue // renderer / gpu / utility
    if (p.cmd.includes('--expose-internals')) {
      host.push(p.pid)
      continue
    }
    // 父进程不在 DSH 里 = 这是被系统拉起来的那个 GUI 主进程
    if (!dshPids.has(p.ppid)) main.push(p.pid)
  }
  return { main, host, all: processes.map((p) => p.pid) }
}

/** 给定 PID 们当前在监听的 TCP 端口集合。 */
function listeningPorts(pids) {
  const wanted = new Set(pids)
  const ports = new Map() // port -> pid
  if (wanted.size === 0) return ports
  const out = run('netstat.exe', ['-ano', '-p', 'TCP'])
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    const pid = Number(cols[cols.length - 1])
    if (!wanted.has(pid)) continue
    const match = /:(\d+)$/.exec(cols[1] || '')
    if (match !== null) ports.set(Number(match[1]), pid)
  }
  return ports
}

/**
 * 这个端口是不是 DSH 的 web 界面。
 *
 * 光看「宿主进程在监听」不够：同一个宿主进程同时开着好几个端口
 * （实测 17321 是 API 网关、59785 才是 web 界面）。挑错端口会让日志
 * 写下一个错的地址，排查时被带偏。
 *
 * 判据是 web 界面的响应特征：未登录时 `/` 返回 401 且正文是
 * `dsh web authentication required; ...`（来自 client-connection 的
 * writeUnauthorized）。API 网关那类端口返回的是 404 JSON，对不上。
 */
function isDshWebPort(port) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2500 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        res.on('end', () => resolve(body.includes('dsh web authentication required')))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** 在候选端口里挑出真正的 web 界面端口。 */
async function findWebPort(candidates) {
  for (const port of candidates) {
    if (await isDshWebPort(port)) return port
  }
  return null
}

async function waitFor(predicate, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return await predicate()
}

/** 按 PID 强杀，忽略不存在的。 */
function killPids(pids, label) {
  if (pids.length === 0) return
  log(`强杀${label}：${pids.join(',')}`)
  for (const pid of pids) run('taskkill.exe', ['/F', '/PID', String(pid)])
}

async function main() {
  log(`=== 助手启动 pid=${process.pid} exe=${EXE} ===`)

  // 自检模式：只报告「我看到了什么、会怎么处理」，不动任何进程。
  // 排查时很有用 —— 不用真重启就能确认分类逻辑对不对。
  if (process.env.DSH_RESTART_DRYRUN === '1') {
    const list = dshProcesses()
    const groups = classify(list)
    log(`DRYRUN 共 ${list.length} 个进程`)
    log(`DRYRUN GUI 主进程：${groups.main.length > 0 ? groups.main.join(',') : '(无)'}`)
    log(`DRYRUN 宿主进程：${groups.host.length > 0 ? groups.host.join(',') : '(无)'}`)
    const ports = listeningPorts(groups.all)
    log(`DRYRUN 监听端口：${ports.size > 0 ? [...ports].map(([p, pid]) => `${p}(pid ${pid})`).join(', ') : '(无)'}`)
    for (const p of list) {
      let kind
      if (p.cmd.includes('--type=')) kind = /--type=(\w+)/.exec(p.cmd)?.[1] ?? 'child'
      else if (p.cmd.includes('--expose-internals')) kind = 'host'
      else if (groups.main.includes(p.pid)) kind = 'MAIN'
      else kind = 'plugin-child'
      log(`DRYRUN   ${p.pid}  ${kind}  ${p.cmd.slice(0, 110)}`)
    }
    return
  }

  if (typeof EXE !== 'string' || !existsSync(EXE)) {
    log(`ABORT 找不到可执行文件：${EXE}（不动任何东西）`)
    return
  }

  // 让刚发出的 HTTP 回包先飞出去，浏览器才收得到「正在重启」。
  await sleep(1500)

  const before = classify(dshProcesses())
  log(`现有 DSH 进程 ${before.all.length} 个：${before.all.length > 0 ? before.all.join(',') : '(无)'}`)

  // 记下重启前就存在的端口，之后判断「新端口」时要用 —— 见文件头第 4 条
  const portsBefore = new Set(listeningPorts(before.all).keys())
  if (portsBefore.size > 0) log(`重启前已在监听的端口：${[...portsBefore].join(',')}`)

  // ① 先杀 GUI 主进程（避免崩溃弹窗 —— 见文件头第 2 条）
  if (before.all.length > 0) {
    if (before.main.length > 0) {
      // 杀不掉就别往下走：主进程还在，后面一杀 renderer 就又弹那个窗。
      // 这时什么都还没破坏，直接退出，DSH 继续正常跑，用户手动重启即可。
      const mainAlive = () => {
        const alive = new Set(dshProcesses().map((p) => p.pid))
        return before.main.some((pid) => alive.has(pid))
      }

      let killed = false
      for (let attempt = 1; attempt <= 3 && !killed; attempt++) {
        killPids(before.main, attempt === 1 ? 'GUI 主进程' : `GUI 主进程（第 ${attempt} 次）`)
        // 判据是「原来那几个 PID 没了」，不是「重新分类后 main 为空」——
        // 主进程一死，它的插件子进程会变成孤儿（父 PID 已不存在），重新分类时
        // 会被误判成 GUI 主进程，于是这个等待会一直挂到超时。
        killed = await waitFor(() => !mainAlive(), 6_000, 300)
      }

      if (!killed) {
        log(`ABORT 杀不掉 GUI 主进程（${before.main.join(',')}）。` +
          '为了不触发崩溃弹窗，本次不动任何其它进程；请手动重启。')
        return
      }
      log('GUI 主进程已退出')
    } else {
      log('没找到 GUI 主进程，改为直接清理全部')
    }

    // ② 再清理剩下的（宿主 / renderer / gpu / 插件子进程）
    const rest = classify(dshProcesses()).all
    if (rest.length > 0) {
      // 按镜像名一把清掉剩下的；这时主进程已经不在了，不会有人弹窗
      log(`按镜像名清理剩余 ${rest.length} 个进程`)
      run('taskkill.exe', ['/F', '/IM', IMAGE])
    }

    const exited = await waitFor(() => classify(dshProcesses()).all.length === 0, 30_000)
    log(exited ? '所有 DSH 进程已退出' : `警告：仍有残留 ${classify(dshProcesses()).all.join(',')}`)
  }

  // 让端口和文件句柄彻底释放，否则新实例可能抢不到端口
  await sleep(2000)

  // ③ 拉起新实例（删掉 ELECTRON_RUN_AS_NODE —— 见文件头第 5 条）
  //
  // 注意：助手是被任务计划服务拉起的，本身**不继承** DSH 的环境（只有 41 个
  // 系统变量，没有 ELECTRON_RUN_AS_NODE，也没有 DSH_HOME/DSH_PROFILE）。
  // 所以这里的 delete 是双保险：万一以后改回直接 spawn，这一行仍然拦得住。
  // 而 DSH_HOME 之类的变量由应用自己在启动时设定，不靠继承。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  let launched = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const child = spawn(EXE, [], {
        cwd: dirname(EXE),
        detached: true,
        stdio: 'ignore',
        // 绝对不能给 windowsHide:true（见文件头第 7 条）：
        // 它会把窗口一起藏掉，新实例在后台跑、桌面上什么都没有。
        windowsHide: false,
        env,
      })
      child.unref()
      log(`第 ${attempt} 次拉起成功 pid=${child.pid}`)
      launched = true
      break
    } catch (error) {
      log(`第 ${attempt} 次拉起失败：${error?.message ?? error}`)
      await sleep(2500)
    }
  }

  if (!launched) {
    log('ERROR 三次都拉不起来，请手动从开始菜单打开 DSH')
    return
  }

  // ④ 等新实例的**宿主进程**开始监听（见文件头第 3、4 条）
  //
  // 给 5 分钟。这台机器装了六十多个插件，冷启动从「进程出现」到「端口开始
  // 监听」能拖到 3 分钟以上。等短了只会写一行假 ERROR，新实例其实好好的。
  //
  // 判据不是「端口号变了」—— 端口是随机分配的，有可能又抽到原来那个。
  // 判据是「这个宿主进程的 PID 是我拉起之后才出现的」：PID 不会复用，
  // 旧宿主已经全死光了，所以新宿主一定是新的。
  const oldHosts = new Set(before.host)
  let port = null
  let hostPid = null

  const ready = await waitFor(async () => {
    const now = classify(dshProcesses())
    const fresh = now.host.filter((pid) => !oldHosts.has(pid))
    if (fresh.length === 0) return false

    const candidates = listeningPorts(now.all)
    const owned = []
    for (const [candidatePort, ownerPid] of candidates) {
      // 只认新宿主进程持有的端口：Roost 的 8080、computer-use 的 mcp 都不算。
      if (fresh.includes(ownerPid)) owned.push(candidatePort)
    }
    if (owned.length === 0) return false

    // 同一个宿主会同时开好几个端口（API 网关、web 界面、插件通道），
    // 要挑出真正能打开界面的那个 —— 见 isDshWebPort。
    const web = await findWebPort(owned)
    if (web === null) return false
    port = web
    hostPid = candidates.get(web) ?? null
    return true
  }, 300_000, 1000)

  if (ready) {
    // ⑤ 把窗口提到前台。
    //
    // 新实例起来时窗口是显示的，但可能被别的窗口盖住，或者用户当时在别的
    // 程序里 —— 他要的是「重启完就能看见 DSH」。这里把主窗口拉到最前。
    // 用 AppActivate 而不是 SetForegroundWindow：前者不需要额外的 Win32
    // 声明，失败也只是不置前，不影响已经起来的实例。
    await sleep(1500)
    const activated = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${hostPid ?? 0} -ErrorAction SilentlyContinue;` +
      `$w=(Get-Process '${PROCESS_NAME}' -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1);` +
      `if($w -ne $null){` +
      `$sh=New-Object -ComObject WScript.Shell;` +
      `$null=$sh.AppActivate($w.Id);` +
      `'ACTIVATED:'+$w.Id` +
      `}else{'NO-WINDOW'}`,
    ])
    log(`窗口置前：${activated.trim() || '(无输出)'}`)
    log(`DONE 新实例已就绪，端口 ${port}（宿主 pid ${hostPid}），全部进程 ${classify(dshProcesses()).all.join(',')}`)
  } else {
    log('ERROR 5 分钟内没等到宿主进程监听端口，请手动检查')
  }
}

main()
  .catch((error) => log(`ERROR 未捕获异常：${error?.stack ?? error}`))
  .finally(() => {
    // 助手立刻退出：没有常驻进程，也就没有残留的控制台窗口
    process.exit(0)
  })
