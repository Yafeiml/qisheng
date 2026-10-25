# Windows 浏览器验真采集端（开发阶段）

仅用于专用 Windows 电脑上的 WorkBuddy 自定义 stdio MCP。业务服务端负责领取工作单、租约、图文评分与数据入库；模型只能看到工作单 ID、状态和证据句柄，不能读取访问 URL、登录态、指标原文或原始证据。本包通过真实浏览器只读取目标笔记 DOM，页面上显示的首张图片可在内存中按生成端同版 64 位 dHash 取指纹；不主动请求私有签名接口、下载评论正文或执行互动。没有图片指纹、字段不足、挑战和登录异常由服务端转人工或熔断。未经过真实样本验收，不代表正式可用或保证不会触发风控。

## Windows 专机需要完成的操作

1. 为采集器准备专用 **Windows x64** 用户、Microsoft Edge 稳定版和 64 位 Node 24.21.0 LTS，并保持专机供电、用户会话和 WorkBuddy 登录。新版默认使用 Edge；仅在明确需要 Chrome 时才设置 `XHS_COLLECTOR_BROWSER_CHANNEL=chrome`。MCP 与离线 mock 使用同一浏览器选择，不读取日常浏览器 Profile。隔离 WorkBuddy 其他通用 shell/浏览器/磁盘工具，只为私有 Skill 开放受限 MCP；若不能隔离，停止配置真实账号与密钥。检查 WorkBuddy 文件自动备份/云同步设置并关闭对浏览器 Profile、状态目录与凭据目录的备份。本轮只允许离线 mock：**不要打开真实小红书页面、登录真实账号或启用真实验真任务**。
2. 从项目提供的最新地址重新取得 `xhs-browser-collector-windows-*.tar.gz` 和**同名** `.sha256`，先在 Windows 专机将两者放在同一目录。在 PowerShell 运行 `Get-FileHash -Algorithm SHA256 <发行包绝对路径>`，与 `.sha256` 文件中的值比对；下载后若只保留了解压目录，可以用下一步校验内部文件，但**不能宣称已核对原始发行包**。解压到全新的专用空目录：`tar -xzf <发行包绝对路径> -C <专用空目录>`。进入解压目录后运行 `node dist/verify-bundle.js`，预期 `BUNDLE_CHECK_OK`；再运行 `node dist/mock-check.js`，预期 `LOCAL_MOCK_CHECK_OK`。新包已包含经锁文件固定并逐文件校验的 **Windows x64** `playwright-core` 与 `sharp` 原生依赖，专机**不运行 `pnpm install`、`wmic.exe`、下载器或依赖脚本**；不建议放松 WorkBuddy 的安全策略。测试页面仅由本地 mock 路由响应，不访问小红书。**不得拷贝整个 WSL 仓库、`.env`、业务数据、生产密钥、Linux `node_modules` 或浏览器 Profile 到采集机。**
3. 在 WorkBuddy 的自定义 MCP 配置中选择 stdio：命令为专机 Node 24.21.0 LTS 的 `node.exe` 绝对路径，参数为**新解包目录下 `dist/main.js`** 的绝对路径；默认无需任何 `pnpm`、`wmic` 或 Chrome 安装。运行时配置 `XHS_COLLECTOR_API_ORIGIN`（API 的 HTTPS origin）、`XHS_COLLECTOR_ID`、`XHS_COLLECTOR_SECRET` 和 `XHS_COLLECTOR_DATA_DIR`（专用 Windows 用户 AppData/Local 下的非云同步目录）。离线发现工具时只用假值和 `https://127.0.0.1`。真实密钥将来由项目管理员安全配置，**不放入 Skill、对话、截图、命令行参数、仓库或日常用户的环境变量导出文件**。专机不可对浏览器 CDP 开公网监听。
4. 导入旁边的 [workbuddy-skill/SKILL.md](workbuddy-skill/SKILL.md) 作为私有 Skill，仅授权这五个 `collector_*` 工具。离线工具发现可在临时独立状态目录使用长度满足校验的 mock ID/假密钥和 `https://127.0.0.1` 作为 API origin，检查 MCP `initialize` 和五个工具名；**不要调用 `collector_claim_job` 或执行 Skill 采集循环**。`collector_get_status` 此时只会显示 `serverOnline: false`，不能算业务链路通过。mock 连接结束后保留守卫文件以供核查，不作为真实账号的运行状态目录。
5. 平台现行 D-017/D-091 规则对登录态有限制。本轮只交付离线 mock；即使工具列表正常也不得联网访问真实小红书或登录真实账号。后续若运营批准单独试点，才由运营人员在 `XHS_COLLECTOR_DATA_DIR` 下的 `browser-profile` 子目录人工正常登录授权账号。切勿导出 Cookie、复制 Profile 到云盘或上传 SaaS；登录与采集进程必须错开使用同一 Profile。
6. 离线验证 WorkBuddy 定时能力时，先用第 4 步假密钥和 `https://127.0.0.1` 配置每小时只运行一次私有 Skill；Skill 会在 `collector_get_status` 返回 `serverOnline: false` 后立即结束，不能领取真实任务。连续观察两轮，并检查锁屏、重新登录和重启后的触发情况。若验证 Windows 任务计划程序后备方式，则单独按小时运行本地 `node.exe <解包目录下 dist/mock-check.js 的绝对路径>` 两轮，勿同一时间开启 WorkBuddy 定时。两种方式的离线观察只证明调度行为，不证明真实浏览器会话安全。服务端 HMAC、审计和真实样本门禁通过后，才能改为真实 API 与工作单；若 WorkBuddy 不能可靠调度，可改用计划任务每小时调用 `node.exe <上述 dist/main.js 绝对路径> --once`，每次仅一条工作单。计划任务需由管理员安全注入相同四个配置项，密钥不得写入命令行或明文脚本；若做不到则不用后备方式。专用用户运行，禁用任务重叠和失败立即重试；不得同时启用两种主触发器。

## 硬限制与本地回执

程序在每次顶层导航前验证后端状态及租约、锁住单实例、预占本地预算（滚动过去 60 分钟内最多 5 次、过去 24 小时最多 40 次）。不同工作单的首次访问至少间隔 60 秒；短链跳转不等待，但每跳仍扣预算。单工作单超过四次顶层导航会阻断并转人工；WorkBuddy 单轮十分钟内不保证处理满五单，不在页面中等待冷却结束。首次访问前永久记录工作单 ID 的已尝试标志；即使崩溃或新租约下再次领取同一 ID，仍暂停并转人工。已开始的访问即使失败也占用。预算和暂停状态保存在 `guard.json`；崩溃残留的 `collector.lock` 不会自动清理。确认旧进程和浏览器均已退出后，由管理员人工处理锁；**不要删除 `guard.json` 来重置预算或解除风控暂停**。登录/风险/验证码/限流/解析器变化会本地暂停，并尝试同步服务端；解除熔断仅能由管理员按审计流程处置，目前客户端无自动恢复工具。

当前浏览器实现每个到期工作单都会启动并关闭一次专用 Edge Profile（明确选 Chrome 时使用专用 Chrome Profile），WorkBuddy 单轮最多五次。频繁启停对登录态稳定性、页面取数和风控的影响仍未知，应在真实样本 P-014 验收中观察记录；本项目不会声称这种生命周期比批次复用更安全。若后续改为批次复用，需先补跨任务请求拦截和页面残留的隔离测试。**首次选择浏览器后保持通道不变，不能混用 Edge 与 Chrome Profile；需要迁移浏览器时先停机，由管理员核查 Profile 和守卫状态，不得清空 `guard.json` 重置访问预算。**

图片 dHash 仅用于已加载且 CSS 可见的首张笔记图片，原图不超过 400 万像素、页面元素不超过 100 万 CSS 像素、截图 PNG 不超过 2 MB、解码后不超过 200 万像素；超限无指纹，服务端走人工复核。浏览器页面其他资源的总字节限额及首图压缩/裁剪误差仍需在真实试点前评估。

Edge 或 Chrome 启动到 Playwright 请求拦截器注册之间存在无法由该拦截器覆盖的窗口。当前会检查专用 Profile 是否上次正常退出且没有配置恢复旧标签；异常或无法识别即暂停，但这些检查和浏览器默认 `about:blank`/禁用背景网络参数**不能证明启动时绝无额外流量**。每次首次使用、异常退出和重启后，须由操作人员检查并关闭旧标签，再由专机管理员在系统/网络层配置出口限制并通过抓包或等价审计验证启动阶段流量。在这些门禁、真实样本和 WorkBuddy 权限隔离通过之前，该 Windows 包仅作本机 mock/受看护试点，**未达到生产安全门槛，也不宣称浏览器运行全程具备 URL 白名单保证**。

请仅回传这些非敏感验收结果：Windows/Node/Edge/WorkBuddy 主版本、SHA256 与 `BUNDLE_CHECK_OK` 是否通过、`LOCAL_MOCK_CHECK_OK` 是否出现、MCP 五个工具是否成功列出、小时触发是否只执行一次、锁屏及重启是否能正常运行。不要发送账号、真实分享链接、浏览器 Profile、Cookie、HMAC 密钥、包含隐私的截图或完整工具日志。

开发者本地验证：`pnpm --filter @xhs-agentic/xhs-browser-collector typecheck`，`pnpm --filter @xhs-agentic/xhs-browser-collector test`，`pnpm --filter @xhs-agentic/xhs-browser-collector build`。测试仅使用本机 mock HTML、伪工作单和离线渲染图片；绝不访问真实小红书。
