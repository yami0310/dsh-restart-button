# dsh-restart-button

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的侧栏底部加一个「重新启动」按钮：一键重启，重启完不留控制台窗口，桌面窗口正常出现。

> **仅支持 Windows。** 整个实现建立在 `schtasks` / `wscript` / `taskkill` / job object 这些 Windows 机制上。

## 用法

左侧栏底部会出现一个圆环箭头按钮：

- **点一下** → 变成「确认重启？」
- **再点一下** → 真的重启（确认状态 3 秒后自动过期）

展开侧栏时显示文字，收成竖条时只剩图标。

## 安装

```bash
git clone https://github.com/yami0310/dsh-restart-button.git
```

然后在 DSH 里用插件管理器加载这个目录（`link:` 方式，方便以后 `git pull` 更新）：

```
plugin_manager install_bundle target=link:<仓库路径>
```

插件管理器会把包名加进 profile 的 `dsh.profile.bundles`，客户端半边会热加载；宿主半边要**重启一次 DSH** 才生效。

## 为什么不点一下就直接重启

这个按钮会立刻掐断当前会话（进程被杀）。侧栏底部紧挨着设置入口，手滑一下代价太大，所以加了一次确认。

## 重启是怎么做的

```
按钮 ──POST──> 宿主半边 ──schtasks /run──> 任务计划服务
                                              │
                                              ▼
                                          wscript
                                              │
                                              ▼
                                       node 助手（helper.mjs）
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
              先杀 GUI 主进程          清理剩余进程            spawn 新实例
             （避免崩溃弹窗）        （按镜像名一把清）      等新宿主开始监听
```

助手跑完就退出，没有常驻进程，所以**不会留下控制台窗口**。

## 九个坑（都踩过）

| 坑 | 现象 | 处理 |
|---|---|---|
| 按进程树杀（`taskkill /T`） | 助手把自己也杀了，日志断在 "force killing" | 助手是 `node.exe`，只按镜像名杀应用进程 |
| **job object 连坐** | DSH 的进程都在一个 `KILL_ON_JOB_CLOSE` 且不许 breakaway 的 job 里；直接 `spawn` 的助手会继承它，DSH 一死助手跟着死 | 绕开 DSH：`schtasks /run` → 任务计划服务 → `wscript` → 助手。助手不在 DSH 的 job 里（实测 DSH job 有 7 个进程，助手那个 job 只有 2 个） |
| **先杀 renderer 会弹崩溃窗** | 主进程还活着而 renderer 先死，主进程的 `render-process-gone` 回调触发 `reportFatal`，弹出「Desktop renderer exited: killed」，还给三个按钮。用户点了「重启」，App 自己又起来一份 —— 表现为「杀完之后冒出一批全新 PID」 | **先杀 GUI 主进程**，主进程没了就没人弹窗；再清理剩下的。**杀不掉就整体放弃**，宁可不重启也不弹窗 |
| **权限不够，杀不掉** | DSH 通常以管理员身份启动（`IsInRole(Administrator)` 为 True）。默认的计划任务是普通权限，`taskkill` 直接返回「拒绝访问」，日志连写 3 次「强杀 GUI 主进程」然后 ABORT —— 看起来像「点了没反应」 | 建任务时加 **`/RL HIGHEST`**。`/query /fo list /v` 里看不到权限字段，得读 `/xml` 的 `<RunLevel>HighestAvailable</RunLevel>` 来校验，否则会复用旧任务 |
| **`windowsHide:true` 把窗口一起藏了** | 重启确实成功，进程、端口都对，但**桌面上看不到 DSH 窗口**。对照实验（同一个 notepad，只改这一个参数）：`windowsHide:true` → `MainWindowHandle=0`、`IsWindowVisible=False`；`false` → `handle=4002634`、`visible=True`。这个参数是为控制台程序设计的，对 GUI 程序会连窗口一起隐藏 | 拉起 DSH 时用 **`windowsHide: false`**；只有调用 tasklist/taskkill/netstat/powershell 这些命令行工具时才用 true |
| 写死端口等就绪 | DSH 每次启动端口都随机（50054 → 52583 → 59072 …），等固定端口会假失败 | 改成「**新出现的**宿主进程有没有在 LISTENING」 |
| **端口挑错** | 同一个宿主进程同时监听好几个端口（实测 17321 是 API 网关、59785 才是 web 界面），日志写 `DONE 端口 17321`，排查的人照着打开只会得到 `{"ok":false,"error":"not_found"}` | 探一下 `/`：web 界面未登录返回 401 + 正文 `dsh web authentication required`；API 网关返回 404 JSON。只认前者 |
| 继承 `ELECTRON_RUN_AS_NODE=1` | 新实例当 node 跑，没窗口、不启 web server | 拉起前 `delete env.ELECTRON_RUN_AS_NODE` |
| **失败后 `busy` 永久卡住** | 重启失败时进程还活着，`busy` 停在 `true`，之后每次点按钮都 409「已经有一次重启在进行」，只能重启 DSH 才能恢复 | `busy` 带 90 秒超时：超时了进程还在，说明上次没成功，自动放行 |

## 排查用的自检模式

不想真重启、只想确认「助手会怎么处理当前进程」时，在仓库目录里：

```bash
DSH_RESTART_DRYRUN=1 node lib/helper.mjs "<DSH 的 exe 路径>"
```

Windows CMD 写法：

```
set DSH_RESTART_DRYRUN=1
node lib\helper.mjs "C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
```

它会往日志里打印每个进程被归为哪一类（`MAIN` / `host` / `renderer` / `plugin-child`）
以及当前所有监听端口，**不动任何进程**。

日志在 `%USERPROFILE%\.dsh\restart-button.log`。

## 配置

| 环境变量 | 作用 |
|---|---|
| `DSH_RESTART_DRYRUN=1` | 只自检，不重启 |
| `DSH_RESTART_NODE` | 指定内置 `node.exe` 的路径。插件默认从「exe 同级的 `resources/runtime/...`」和「`~/.dsh/dsh-runtimes/...`」两处找，都不在时才需要设这个 |

## 安全

接口只接受本机同源请求：Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，且 `Origin`（若有）必须与 Host 完全一致。浏览器里别的页面发不出去这个 POST（实测外站 Origin 返回 403）。

同时只允许一个重启在进行，连点第二下返回 409。

## 文件

| 路径 | 作用 |
|---|---|
| `lib/client.js` | 网页半边：侧栏按钮 + 两段式确认 |
| `lib/index.js` | 宿主半边：`/api/dsh-restart-button` 路由，写启动脚本、建任务、触发 |
| `lib/helper.mjs` | 重启助手：杀 → 等 → 拉起 → 等就绪 |
| `~/.dsh/restart-button.launch.vbs` | 生成的启动脚本（纯 ASCII，wscript 用） |
| `~/.dsh/restart-button.log` | 助手日志 |
| 计划任务 `DSHRestartButton` | 让助手脱离 DSH 的 job object |

## 卸载

插件页停用 `dsh-restart-button` 即可。想连计划任务一起清掉：

```
schtasks /delete /tn DSHRestartButton /f
```

## License

[MIT](LICENSE)
