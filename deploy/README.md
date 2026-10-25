# Docker 部署与网页安装

每套安装服务一家企业或一个集团。在 Linux amd64 上使用 Docker 和 Docker Compose 2.24.0+ 运行已经构建的镜像，无需在运行主机安装 Node.js、先填写域名或等待 DNS 解析。首版采用 Apache-2.0，只发布源码，镜像须先在本机或构建机制作；完整新用户步骤见[部署与常见问题](../docs/deployment.md)。

## 1. Docker 基础部署

将部署文件与已构建的应用镜像交付到运行主机，在项目目录执行：

```sh
docker compose -f deploy/compose.yml up -d --no-build
```

普通安装默认在同一台主机、同一个 Compose 项目中同时运行 API、Web 和 Worker；上述一条命令会一起启动，不要求另备服务器或单独安装 Worker。Worker 使用独立容器承接异步任务，一个容器可同时消费生成与素材队列。只有需要增加处理能力时，才按需增加同机副本或选择其他主机；本机存储模式仍须共享同一真实存储目录。

默认镜像标签为 `local`。使用其他版本时，通过 Compose 的 `QISHENG_VERSION` 环境变量选择已交付标签；不要在运行主机现场编译或 `up --build`。默认直接运行时不需要 `.env`。

Compose 自动完成：

1. bootstrap 生成并持久保存独立应用密钥、数据库密码和首次安装凭证。
2. 启动 PostgreSQL 18（含 pgvector）与 Redis 8.2，等待基础设施健康。
3. 应用兼容迁移；成功后启动 API、Web 和 Worker。迁移失败则停止后续应用启动。
4. 仅向外发布 Web 端口 `3101`；API、数据库与 Redis 留在内部网络。

打开 `http://服务器IP:3101` 或直接访问 `/setup`。若需不同端口，使用 `WEB_BIND_PORT` 选择端口即可；不需要填写 API 的外部地址或域名。防火墙需允许所选 Web 端口。

首次安装凭证只在受信任终端中查看，不放进 URL 或普通日志：

```sh
docker compose -f deploy/compose.yml run --rm -it bootstrap token
```

## 2. 在网页完成基础配置

1. 在 `/setup` 输入安装凭证，设置主管理员账号密码和组织名称，选择单企业或集团。
2. 单企业自动建立一家企业；集团下属企业由管理员在后台手动新增。
3. 提交管理员与组织配置后即显示“安装完成”，点击“进入工作台”开始使用。新安装自动使用本机存储，无需选择存储方式、测试连接或填写 S3 密钥；安装向导不包含模型、审核等配置。
4. 管理员在后台创建其他管理员和员工账号，设置初始密码；没有自助注册入口。

需要 S3 时，在后台存储设置（`/platform/settings/storage`）完成配置并按下文要求切换；模型与图文审核也在后台配置，配置和验证完成前仍禁止生成/分发。安装完成不会降低 API 业务就绪与生产审核门禁。

安装向导和登录通过当前网站的 `/api` 调用内部 API，不使用外部 DNS；无需先配置 S3、模型或审核即可进入工作台。

HTTP IP 地址支持安装、登录和会话刷新；浏览器安全剪贴板不可用时提供普通复制/手动复制。公网使用 HTTPS 可保护传输，但不将 HTTPS 或域名解析作为打开安装界面的前置条件。

本机存储将文件保存在 `${QISHENG_DATA_DIR}/storage/`（默认 `deploy/data/storage/`），只挂载到 API 与 Worker；容器内固定为 `/var/lib/qisheng/storage`，由 bootstrap 设置为应用 UID 1000 持有的私有目录。上传、下载均经短期签名接口 `/api/storage/objects/{token}`，不会开放静态目录或匿名列表，也不需要配置域名。API 和 Worker 必须挂载同一真实目录；修改路径前停止服务并自行迁移文件，不能把新空目录当成原数据。

S3 模式使用独立服务：私有 Bucket、签名地址、浏览器 CORS 与 HTTPS 混合内容规则仍需按实际访问方式配置。不要开放匿名写入；本系统不自动新增 MinIO。S3 密钥继续加密保存。本机模式不执行 S3 版本控制或云生命周期操作。

已有安装的存储设置不会因打开安装页或升级而改变；没有 `storage.provider` 的旧安装仍按 S3 兼容运行，需要切换时由管理员在后台显式操作。已有文件或处理中的业务任务时禁止切换存储后端，避免原文件失联；本次不自动迁移、复制或删除旧文件。调整已有安装前先停止 Worker，并暂停上传及创建任务；保存和验证完成后再启动 Worker，使其重新加载配置。这是维护操作，不支持在线热切换。两种模式均受原有容量、素材授权和生成审核门禁约束。

非 Docker 开发环境选择 LOCAL 时，为 API 和 Worker 配置相同的绝对 `OBJECT_STORAGE_LOCAL_ROOT`，并保留原管理员密钥；文件签名由该密钥按独立用途派生，不新增需要手工填写的秘密。旧的 `backup.sh`、`restore*.sh` 和 `audit-object-ownership.sh` 针对 S3/MinIO 开发环境，不适用于本机目录；本轮不扩展或自动执行备份、清理工具。

## 3. 任意域名反向代理

域名只在自己的 DNS 与反向代理中配置，不在企声中绑定，也不用重建 Web 镜像。将整站转发到 Web `3101` 端口，`/api` 由 Web 内部转发，不需另暴露 API 端口。

Nginx location 示例（证书与 server_name 由自己的代理管理）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3101;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

代理须覆盖并传递原始 Host 和协议，不能将浏览器来源误改为容器内部地址。HTTP 访问使用相应 Cookie，HTTPS 自动保留 Secure；两者均保留 HttpOnly、SameSite 及跨站请求校验。不能用反射任意 Origin 或开放带凭据 CORS 来代替正确代理。更换域名后需在新域名登录一次，不迁移浏览器的旧域名 Cookie。

`INTERNAL_API_BASE_URL` 仅是 Web 到 API 的内部服务地址，默认 `http://api:3100`。普通安装不要修改 `ADMIN_WEB_ORIGIN` 或设置公开的 `NEXT_PUBLIC_API_BASE_URL`；这些旧配置仅为独立直连 API 的兼容场景保留。

## 4. 数据与升级

配置和实际数据默认保存在 `deploy/data/`，可用 `QISHENG_DATA_DIR` 指定真实路径。`config/runtime.json` 及派生的数据库配置文件是私有恢复状态，不进入 Git、镜像、源码快照或公开问题报告。配置目录 0700、文件 0600，由应用 UID 1000 持有，Web 不挂载这些秘密。

重启和升级复用原密钥，不重新随机生成。缺失部分旧密钥、环境与已保存密钥冲突、密码文件不同都会拒绝覆盖。迁移文件不篡改，不能 `db push` 或 `down -v`，保持原数据库与镜像回滚标签；本项目不自动复制或备份业务数据。

本轮结构清理是维护升级：先停止旧版 Web、API 和 Worker，再交付全部新镜像、运行迁移并启动新版本，不能与旧 Worker 混跑。新迁移删除已退休的余额、购点表和关联字段，保留活动、成员、工作项状态、资料、审计与存储数据。数据库提交后不能直接切回依赖旧表的镜像。该迁移登记为 `maintenanceRequired`，不会被当作兼容滚动迁移；本轮开发不对已部署数据库执行它。

维护者在现有 Ubuntu 上安装时，配置与真实数据使用 `/home/docker/qisheng/`，复用已有数据库/Redis，不把 WSLC 路径当成 Ubuntu。Linux 引擎、Windows WSLC 的镜像存储相互独立，必须通过仓库或镜像归档显式交付。

## 5. 复用现有数据库（高级）

已有数据库使用覆盖文件，避免重复启动内置实例：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.external.yml up -d --no-build
```

私有 `.env` 填写自己的 `DATABASE_URL`、`REDIS_URL` 和完整应用密钥。复用已有业务库时必须沿用其原 `MODEL_CREDENTIAL_ENCRYPTION_KEY` 与其他应用密钥；缺少原密钥不能通过随机新密钥冒充迁移成功。PostgreSQL 需要 vector、btree_gist、pgcrypto、pg_trgm 扩展及相应迁移权限。不要激活 `bundled-disabled` profile。

通过 1Panel 创建专用空库时，还需确认应用账号对该库的 `public` schema 拥有 `USAGE` 和 `CREATE` 权限；仅授予数据库连接权限不足以执行迁移。由数据库管理员预装上述扩展并授予专用 schema 权限，应用账号保持普通角色，不授予超级用户权限。生产迁移不需要影子库，未配置时不传 `SHADOW_DATABASE_URL`。

已有私有 `.env` 会被采用，不因启用持久配置目录而替换原加密主密钥。尚未部署的新外部数据库也可在构建机运行可选的 `node deploy/self-host.mjs configure` 分步生成配置；它不再询问域名或 API 外部地址，运行主机仍不需要 Node.js。

## 6. 本机构建与验证

维护者使用项目 Node.js 24.21.0，在 Windows 工作目录直接运行：

```sh
node deploy/self-host.mjs build local
```

Windows 由 WSLC 执行 Linux 镜像构建，源码不另行同步到 WSL；Linux 构建机使用本机 Docker。全部源码编译、安装依赖与打包在本机完成。构建不需要域名、真实配置或 `.env`。按版本交付 api/web/worker/migrate 四镜像，运行主机不触发构建。

## 7. 可选能力与诊断

Worker 与主服务共同启动，安装期尚未启动的处理模块每 30 秒重新读取所需配置并重试，不因生成审核尚未配置而关闭整个 Worker。新安装自动使用本机存储，随后按需配置生成模型与图文审核；正式生成仍须通过当前审核配置的验证。队列门禁按真实在线消费者检查，不会把运行中的空容器当作就绪。配置未完成时先查看 `worker` 日志和门禁的具体原因，无需为此另行部署独立服务器。

已启动的处理模块继续使用既有连接与审核扫描器。后续更换存储、审核等配置时仍按维护流程重启 Worker；自动重试仅用于尚未启动的模块，不代表运行中的模块支持配置热更新。邮件、短信、CAP、小程序与回读都不是安装前提，启用时按各自的外部地址和凭据配置；应用同源访问不代替独立服务设置。

发布核验默认人工复核，自动回读是可选增强，不阻断安装、登录或内容生成。未启用时显示“自动回读未启用（可选）”，回填链接保留为待人工确认，不冒充自动核验通过。需要时在主后台“发布复核与回读”保存自己的兼容公开 HTTPS 笔记详情接口和 Token，完成明确确认费用的样本测试后启用。接口支持 GET `noteId` 查询参数、通用 JSON 和现有双层 JSON 协议，项目不附带供应商账号或凭据。

同机部署不需要另一台服务器或单独设置节点面板。在本机构建可选镜像 `node deploy/self-host.mjs build-readback <版本>`，交付后先用原 Compose 配置运行 `run --rm --no-deps bootstrap`，再加入 `-f deploy/compose.readback.yml` 执行 `up -d --no-build readback`。bootstrap 仅补齐独立的只读节点签名文件，保留原安装配置；采集容器不挂载管理员主密钥或数据库凭据，不暴露面板端口。默认四服务构建与普通安装不主动启动它。

独立服务器、多节点与独立面板仍可作为高级方式，网络不限定特定软件；旧节点的签名身份和供应商凭据管理保持兼容。完整的同机命令、接口格式、已有安装升级顺序及高级配置见[回读节点说明](../packages/xhs-api-collector/README.md)。

```sh
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail 100 api worker
docker compose -f deploy/compose.yml stop
```

停止保留数据，日志分享前脱敏。验证 Compose 使用 `config --quiet`，不要上传展开私有环境的完整配置。Windows 开发机可运行 `pnpm accounts:set-password` 为已有手机号管理员设置密码，不能通过命令行参数或聊天传递密码。历史安装记录不代替本轮验证；真实供应商调用和外部平台发布需另行验收。本轮改造不执行生产部署。
