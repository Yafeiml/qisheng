# 小红书 SSR HTML 单链接验证工具

这是一份**只读可行性探针**，不是发布验真服务，也不生成“发布成功/失败”结论。它只使用 Node 22 内置模块，从当前 Windows 专机网络对一条笔记链接发一次匿名 HTTPS GET；短链最多跟随两次**限定在小红书笔记域名和路径**内的跳转。工具不启用 Edge/WorkBuddy，不登录、不读取 Cookie、不模拟客户端签名、不访问内部详情接口、不下载封面图片、不读取点赞/收藏/评论、不重试，也不写原始 HTML、链接或笔记正文到文件。

## Windows 专机运行

1. 将发行包解压到专机的独立目录。只运行你自己核对过 SHA-256 的包；无需 `pnpm install` 或 Docker。
2. 在 PowerShell 中进入解压目录，运行 `node .\inspect-xhs-ssr.mjs --self-test`，应看到 `SELF_TEST_OK`。此步骤不联网。
3. **先运行 `node .\inspect-xhs-ssr.mjs --diagnose-dns`**；仅解析两个固定域名，不请求小红书网页，也不需要输入笔记链接。如果输出 `FAKE_IP`，说明本机 DNS 把这两个域名映射到代理使用的 `198.18.0.0/15` 或 `2001:2::/48` 测试地址。这种情况只在你确认是自己使用的代理／虚拟网卡配置后，改用 `node .\inspect-xhs-ssr.mjs --show-text --allow-fake-dns`。此开关**只允许这两个固定的 Fake-IP 段**，仍禁止回环、局域网和任意私有地址，仍要求限定的小红书域名、HTTPS 与正常 TLS 证书；它不会修复代理本身无法连通的问题。若结果是 `PUBLIC`，继续运行 `node .\inspect-xhs-ssr.mjs --show-text`；若是 `PRIVATE_OR_RESERVED` 或 `DNS_FAILED`，不要继续访问笔记，先核查本机 DNS／代理设置。
4. 出现隐藏输入提示后粘贴**一条你有权核查的公开笔记链接**并回车；输入不回显，也不会进入命令历史。`--show-text` 仅在你本机终端显示标题和前 2000 字正文，方便你与发布原文人工比较。不想显示文字则省略 `--show-text`。**不要把链接写在命令参数、聊天或截图里，也不要把显示了正文的完整终端日志发给别人。**
5. 若看到 `POSSIBLE_RISK_OR_RATE_LIMIT`、`POSSIBLE_CHALLENGE`、`REDIRECT_UNRESOLVED`、`TIMEOUT` 或任何风控提示，停止后续样本，不更换账号、IP 或浏览器重试。本工具不判断员工是否发布。`REDIRECT_UNRESOLVED` 增加固定的 `redirectReason` 类别，但不跟随未知地址、不输出目标链接；单凭 302 不能判断是否风控。

可回传给项目的字段只有分类 `classification`、HTTP 状态码、`fields` 中各字段长度和布尔值、是否短链跳转，以及你自己人工确认的三项“正文完整吗／封面可核对吗／笔记身份对吗”。**不要回传**链接、访问参数、原始 HTML、正文、图片地址、Cookie 或个人资料。

| 结果 | 含义 |
| --- | --- |
| `NOTE_FIELDS_CANDIDATE` | 初始 HTML 中有可解析的 `__INITIAL_STATE__`，其目标笔记 ID 与链接一致，并有标题、正文和至少一张图片字段。仍需人工核对全文与实际图片；不能自动认定发布成功。 |
| `METADATA_OR_PARTIAL_ONLY` | 只见 SEO 元标签或 JSON-LD 信息，或初始状态没有完整的目标笔记字段。摘要和封面元数据不足以按当前策略自动验真。 |
| `HTML_SHELL_OR_UNKNOWN` | 没读到可判定字段；可能是页面壳，也可能是探针还不认识的 HTML 结构。 |
| `HTTP_UNAVAILABLE` / `NOT_HTML` | 请求返回不可用或非 HTML，**不代表笔记未发布**。 |
| `POSSIBLE_RISK_OR_RATE_LIMIT` / `POSSIBLE_CHALLENGE` / `REDIRECT_UNRESOLVED` | 限制、验证、登录跳转或其他不确定状态；立即停测，不据此判员工失败。`redirectReason` 可能为 `LOGIN_OR_AUTH`、`SITE_HOME`、`OTHER_XHS_PATH`、`UNSUPPORTED_NOTE_PATH`、`OTHER_HOST`、`NON_HTTPS`、`UNSAFE_TARGET`、`INVALID_LOCATION`、`MISSING_LOCATION` 或 `TOO_MANY_REDIRECTS`；这些只是目标地址的类别，不等于服务端风控结论。 |

`metadataCoverPresent` 和 `noteImages` 只说明页面包含图片字段，**没有下载图片，更没有进行员工独立图片指纹匹配**。`noteBodyChars` 是字段字符数，仍需你人工确认全文、对应笔记和可见性。同一链接的匿名 HTML 能否稳定返回，与生产服务器的网络出口、受限笔记类型或不同时间的表现也可能不同。先用少量已授权的正例、短链、不可访问及改写样本判断可行性；通过之后再讨论服务架构与自动确认阈值，不把这份探针结果冒充 P-014 验收。

## 2026-09-24 本地实测

在当前 WSL 网络出口，从公开 GitHub issue [样本一](https://github.com/R2DM/v2ex_mofish/issues/258) 和 [样本二](https://github.com/PeanutSplash/xhs-data-helper/issues/21) 中各选一条笔记链接，每条仅请求一次、不携带账号或 Cookie。两次均得到 `HTTP 302`、`redirects: 0`、`REDIRECT_UNRESOLVED`、`redirectReason: OTHER_XHS_PATH`，没有读到 SSR HTML。当前环境的两个固定域名 DNS 诊断均为 `FAKE_IP`，测试显式启用 `--allow-fake-dns`。此结果只说明当前出口对这两条样本的响应；没有验证 Windows 专机或生产出口，也没有证明是风控、笔记失效或 SSR 方案不可行。没有保存原始 HTML、目标跳转地址或笔记内容。
