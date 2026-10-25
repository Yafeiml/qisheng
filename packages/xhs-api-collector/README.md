# 小红书笔记详情采集节点与控制台

回读是可选的自动发布核验与互动指标采集能力，普通安装默认人工复核，不需要部署回读节点。同机模式由企声主后台统一管理供应商配置，容器只运行采集循环；独立节点与面板继续作为高级部署方式。供应商地址是笔记详情查询接口，**不是企声主服务地址**，不能把网站首页或模型生成接口直接填入。

## 接口协议

填写自己的、符合下述协议的完整公开 HTTPS Endpoint，例如 `https://api.example.com/notes/detail`。示例地址仅用于说明格式，项目不附带供应商账号、Token 或服务。节点使用 `GET` 请求，将待回读笔记 ID 写入 `noteId` 查询参数；允许已有非敏感查询参数，同名 `noteId` 会被替换。地址不得包含用户名、密码、片段或密钥。Token 放在单独的输入框中，可带 `Bearer` 或 `Token` 前缀；不带前缀时发送 `Authorization: Token <token>`。

成功查询应返回 HTTP 200 与 JSON 对象，最小格式如下：

```json
{
  "noteId": "请求中的笔记 ID",
  "title": "笔记标题",
  "body": "笔记正文"
}
```

`noteId` 必须与请求一致。还支持以下可选字段：

| 字段 | 格式 |
| --- | --- |
| `authorId` | 6–100 位作者 ID，仅字母、数字、下划线和连字符；可缺失或为 `null` |
| `publishedAt` | ISO 时间字符串，或秒 / 毫秒 Unix 时间戳 |
| `imageCount` | 0–40 的整数；缺失时为 0，超出范围则拒绝该响应 |
| `hashtags` | 字符串数组 |
| `likes`、`comments`、`favorites` | 非负整数；缺失时视为未提供，不补为 0 |

**启用节点前的样本验收还要求标题与正文非空，并取得点赞、评论、收藏三个数量。** 最小格式可被解析，但缺少这些字段时不能通过启用验收。仍兼容历史的外层 `code: 0, data: "…"`、内层 `code: 0, success: true, data: […]` 双层 JSON 笔记结构。需要 POST、不同参数名、自定义鉴权或其他 JSON 结构的供应商，应先通过用户自己的网关适配，节点没有自动推断接口的功能。

`note-detail.ts` 对配置地址进行校验，实际请求还校验 DNS 为公开地址，拒绝重定向；一次调用超时 12 秒，最多读取 2 MiB 响应，无内部重试。供应商异常、笔记 ID 不符或格式不兼容不会直接判定员工提交无效。

## 配置与使用

运行 `./scripts/dev/pnpm.sh --filter @xhs-agentic/xhs-api-collector build` 与 `test` 检查本地实现。库入口 `dist/index.js` 只导出请求与解析函数，导入不会启动节点；服务入口仍为 `dist/main.js`。

### 同机部署（推荐）

1. 默认保持人工复核。管理员在主后台“发布复核与回读”中保存供应商 API 地址与 Token；密钥加密保存且不回显。
2. 在本机构建可选镜像：`node deploy/self-host.mjs build-readback <版本>`，然后按主系统方式显式交付镜像。运行主机不现场构建。
3. 更新 API 与 bootstrap 到同一兼容版本。先运行下面的 bootstrap 命令，它保留原配置与密钥，仅补齐独立节点身份；再启用已有的同机覆盖文件：

```sh
docker compose -f deploy/compose.yml run --rm --no-deps bootstrap
docker compose -f deploy/compose.yml -f deploy/compose.readback.yml up -d --no-build readback
```

使用外部数据库或已有网络覆盖文件的安装，应在两条命令中继续带上原覆盖文件，不另外创建或清空数据库。版本使用既有 `QISHENG_VERSION`，确保所选标签已交付。

4. 在主后台用有权核查的样本链接进行测试，确认可能产生供应商费用。当前配置通过样本测试后，才可启用自动回读。接口或 Token 改变后必须重新验证。

同机容器通过 Docker 网络的 `http://api:3100` 访问主服务，身份固定为 `selfhost-readback`。bootstrap 从已保存的应用密钥按独立用途派生随机强度的签名密钥，保存于 `config/readback-node-key`，文件权限为 0600。容器仅只读挂载这个单文件，不取得数据库密码、管理员 JWT 主密钥或整个配置目录，也不启动面板或暴露端口。供应商凭据只随已领取的签名任务提供给该受管身份，不写进镜像、Compose 或日志。关闭自动回读或没有到期任务时不调用供应商；每次租约最多查询一次，确认回执丢失只重试回执。

同机模式的 `READBACK_MANAGED=true`、主服务地址、节点 ID 和 `PUBLICATION_READBACK_NODE_KEY_FILE` 已由覆盖文件提供，无需手工复制密钥或配置节点面板。主后台显示“自动回读未启用（可选）”时表示人工复核模式，不是主服务停机。

### 外部节点与独立面板（高级）

未设置 `READBACK_MANAGED=true` 时，入口 `dist/main.js` 保留原控制台与采集循环；缺少供应商地址、Token 或成功样本验收时不领取工作单。外部节点的供应商凭据继续在自己的面板管理。

网络方式由部署者决定，可使用本机、局域网、Docker 网络、公网或反向代理，不要求安装特定网络软件。主服务连接与节点面板的配置如下，独立于供应商 API 地址：

| 环境变量 | 填写内容 |
| --- | --- |
| `PUBLICATION_READBACK_API_BASE_URL` | 节点访问企声 API 的 HTTP(S) 地址，支持私网 IP、Docker 服务名、任意端口及反向代理路径前缀，例如 `http://api:3100` 或 `https://app.example.com/api` |
| `PUBLICATION_READBACK_NODE_ID` | 节点 ID，与主服务 `PUBLICATION_READBACK_NODE_KEYS_JSON` 中的 ID 一致 |
| `PUBLICATION_READBACK_NODE_KEY` | 此节点独立的随机签名密钥，与主服务中对应值一致；至少 32 位，不使用示例字符串 |
| `READBACK_PANEL_HOST` | 本机监听绑定 IP，默认 `127.0.0.1`；支持本机可绑定的 IPv4、IPv6，以及 `0.0.0.0`、`::` |
| `READBACK_PANEL_PORT` | 本机监听端口，默认 `13110`，可自行修改 |
| `READBACK_PANEL_PUBLIC_URL` | 用户浏览器实际访问的 HTTP(S) 根 URL，支持域名、IPv6、端口及 HTTPS 反向代理，例如 `https://readback.example.com:8443/` 或 `http://[::1]:13110/`；不支持子路径 |
| `READBACK_PANEL_SETUP_IPS` | 允许首次设置密码的设备来源 IP，逗号分隔，支持任意 IPv4 / IPv6，默认 `127.0.0.1,::1`，没有指定网段要求 |
| `READBACK_STATE_DIR` | 节点私有持久目录，默认 `/var/lib/qisheng-readback`，须允许运行用户写入，用于保存加密凭据、密码与节点状态 |

监听地址与访问地址可以不同。绑定 `0.0.0.0` 或 `::` 时，必须设置 `READBACK_PANEL_PUBLIC_URL`，它们本身不能作为浏览器入口；使用容器映射端口或反向代理时也应显式配置浏览器实际入口。主服务会展示节点上报的完整面板地址，不补写固定端口。首次设置密码前可先从本机完成初始化，再配置反向代理；通过代理初始化时，允许列表应填写节点实际看到的连接来源 IP。登录密码、会话和 CSRF 校验仍然生效。

#### 外部面板的普通 Docker 网络示例

先在本机或构建机运行 `docker build -f deploy/docker/Dockerfile --target readback -t qisheng/readback:v1 .`（Windows 使用 `wslc build`）。镜像交付与主系统相同，运行主机不现场构建。在现有 `deploy/compose.yml` 旁另建 `compose.readback.external.yml`，不要覆盖同机受管节点文件：

```yaml
services:
  readback:
    image: qisheng/readback:v1
    restart: unless-stopped
    env_file: [.env.readback]
    ports: ["127.0.0.1:13110:13110"]
    volumes: ["readback-state:/home/node"]
volumes:
  readback-state:
```

`deploy/.env.readback` 使用自己的值替换以下占位符，不提交 Git；该文件已被现有忽略规则排除。此示例通过同一 Compose 网络的服务名访问 API，浏览器从部署主机的 localhost 打开面板：

```dotenv
PUBLICATION_READBACK_API_BASE_URL=http://api:3100
PUBLICATION_READBACK_NODE_ID=readback-1
PUBLICATION_READBACK_NODE_KEY=replace_with_an_independent_random_secret
READBACK_PANEL_HOST=0.0.0.0
READBACK_PANEL_PORT=13110
READBACK_PANEL_PUBLIC_URL=http://localhost:13110/
READBACK_PANEL_SETUP_IPS=replace_with_device_source_ip_seen_by_node
READBACK_STATE_DIR=/home/node/readback-state
```

在主服务私有 `deploy/.env` 的 `PUBLICATION_READBACK_NODE_KEYS_JSON` 中登记相同 ID 与随机密钥，例如 `{"readback-1":"replace_with_the_same_random_secret"}`。初始化设备来源 IP 可能是 Docker 网桥地址或代理地址，按自己的实际网络填写；不限制操作系统。供应商凭据在面板内填写，此文件不需要供应商 Token。然后在仓库根目录执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.readback.external.yml up -d --no-build api readback
```

完成密码设置、供应商配置和样本验收后，再启用节点与主服务 `PUBLICATION_READBACK_ENABLED`；主服务配置变化后重新创建 API 容器。供应商接口的公开 HTTPS 与 DNS 检查用于防止 SSRF，不是节点之间的网络限制。

已有安装应先执行主系统兼容迁移并更新 API，再更新回读节点。新面板 URL 会纳入节点签名；旧节点的签名与历史地址记录继续兼容。

在外部节点控制台首次设置密码后，手动填写供应商 API 地址与 Token。此模式的 Token 以 AES-256-GCM 加密保存在节点专属持久目录，不回显、不传给主服务。后续保存时 Token 留空会保留旧值；修改 API 地址或 Token 会暂停节点并清除样本验收状态，需重新测试再启用。从内置供应商地址的旧版本升级时保留原 Token，但必须手动补充供应商地址并重新验收，不自动恢复历史供应商地址。

控制台显示最近 50 条工作单、主服务最近 14 天每日领取额度，以及领取额度和人工测试的合计次数；不估算供应商费用，实际调用与扣费以供应商账单为准。人工样本测试每天最多 3 次，每次必须勾选收费提示，不领取工作单。节点启停不改变主服务的回读总开关：主服务未启用时，节点待命，不会发起自动查询。

控制台的“真实样本验收”代替命令行录入。旧的 `node dist/smoke.js` 仍支持从 TTY 隐藏读取笔记链接或 ID；供应商地址和 Token 分别优先读取 `PUBLICATION_READBACK_PROVIDER_ENDPOINT` 与 `PUBLICATION_READBACK_PROVIDER_TOKEN`，其次读取 `READBACK_STATE_DIR` 指定的本节点配置，不领取主服务工作单。离线测试不会请求真实供应商；上线前应使用有权核查的样本完成付费兼容性验收。
