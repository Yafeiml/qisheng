# 企声发布部署与常见问题

本文面向自托管用户。一套安装服务一家企业或一个集团；Docker 同时运行 API、Web 和内容 Worker，默认带 PostgreSQL、Redis 和本机文件存储。数据库、模型供应商、存储文件与应用密钥均由部署者管理。

日常操作见[操作说明](user-guide.md)，容器定义见[Compose 文件](../deploy/compose.yml)。默认使用员工网页；微信客户端另按[小程序自部署说明](miniapp.md)配对自己的应用。**v0.1.1 发布源码和固定版本标签，不提供官方预构建镜像**。先在自己的本机或构建机制作镜像，再交付到运行主机；不要直接执行默认 Compose 并期待自动下载 `qisheng/*` 镜像。

以下命令从源码根目录执行。`VERSION` 对应固定发布版本，`IMAGE_ARCHIVE` 是你已制作并安全交付的镜像归档路径。本文不假设某个镜像仓库已经可用。

## 1. 准备运行主机与版本文件

首版容器构建目标为 **Linux amd64（x86-64）**，需要 Docker Engine 和 Docker Compose **2.24.0 或更高版本**。ARM 主机不能直接按已验证的 amd64 环境承诺可用。已有 Docker 的用户可检查：

```sh
docker version
docker compose version
uname -m
```

准备一个固定的部署目录，以及可持续增长的磁盘空间。首版未给出经过完整容量测试的生产最低 CPU、内存和磁盘规格；少量账号能登录的测试结果不能当作批量生成的容量保证。内存需求取决于 API、Worker 并发和文件处理，磁盘还需容纳镜像、升级时的新旧镜像、数据库、日志及用户素材。模型默认通过部署者自己的接口调用，不因运行 Web 就要求本机 GPU。

首版可在构建机获取固定版本源码：

```sh
git clone --branch v0.1.1 --depth 1 https://github.com/Yafeiml/qisheng.git
cd qisheng
```

也可以从仓库的 v0.1.1 标签下载源码压缩包并解压。随后按[第 9 节](#9-从源码在构建机制作镜像)构建、导出和交付镜像，再进行下面的导入与启动。不要把个人开发环境、真实 `.env` 或其他安装的密钥复制成一套“通用配置”。

### 已有构建镜像的用户

收到自己或可信构建者制作的离线镜像归档后，先与构建机记录的校验值比对，再导入：

```sh
VERSION='v0.1.1'
IMAGE_ARCHIVE='/替换为已下载镜像归档的绝对路径'
sha256sum "$IMAGE_ARCHIVE"
docker load -i "$IMAGE_ARCHIVE"
export QISHENG_VERSION="$VERSION"
```

主系统需要 `qisheng/api:$VERSION`、`qisheng/web:$VERSION`、`qisheng/worker:$VERSION`、`qisheng/migrate:$VERSION` 四项镜像。可选自动回读还需要 `qisheng/readback:$VERSION`。先用 `docker image inspect` 核对实际标签；不要只根据归档文件名判断版本。首版未发布镜像仓库，不要猜测 GHCR 或 Docker Hub 名称。

运行主机使用已构建镜像，不在更新时执行 `docker build`、`docker compose build` 或 `up --build`。需要自行构建时，先完成[第 9 节](#9-从源码在构建机制作镜像)，再交付镜像到运行主机。

## 2. Docker 基础启动

普通新安装不需要先创建 `.env`，也不需要先填写域名、DNS、数据库账号或 S3 配置。建议先选择固定的真实数据目录，例如：

```sh
export QISHENG_DATA_DIR='/srv/qisheng/data'
export WEB_BIND_PORT=3101
docker compose -f deploy/compose.yml config --quiet
docker compose -f deploy/compose.yml up -d --no-build --pull never
docker compose -f deploy/compose.yml ps
```

`QISHENG_VERSION` 沿用前一步选定的已导入版本。`QISHENG_DATA_DIR` 使用自己的绝对路径；不指定时，默认数据位于 `deploy/data/`。新终端或维护脚本中也应使用相同的版本、数据路径、端口、项目名和覆盖文件，避免无意中启动另一套空安装。

启动顺序如下：

1. `bootstrap` 生成并持久保存独立应用密钥、数据库密码和首次安装凭证。
2. PostgreSQL 与 Redis 启动并通过健康检查。
3. `migrate` 应用数据库迁移；失败时不会继续启动依赖它的 API。
4. API、Web 和 Worker 启动。Worker 已包含在普通部署中，不要求另一台服务器。

只有 Web 的默认 `3101` 端口对主机公开；API、数据库和 Redis 留在 Compose 网络内。主机或云防火墙需允许选择的 Web 端口。

打开 `http://服务器IP:3101/setup`，端口变化时相应替换地址。域名没有解析不会阻止 IP 加端口访问安装页。

## 3. 网页初始化

在受信任的交互终端查看首次安装凭证：

```sh
docker compose -f deploy/compose.yml run --rm -it bootstrap token
```

此命令需要交互终端，不应把凭证输出重定向到普通日志、写入 URL、上传 Issue 或录入公开截图。安装凭证只用于首次创建管理员，不是建议沿用的管理员密码；请为管理员设置独立密码。

在网页填写安装凭证、主管理员账号密码、组织类型和名称。单企业自动创建一家企业；集团旗下企业由管理员在后台新增。提交后即可看到“安装完成”，点击“进入工作台”。安装向导不包含模型、审核或存储配置。

已有管理员或组织时，初始化接口不会覆盖原账号和数据。后续从 `/login` 登录，员工从 `/employee` 登录；没有公开注册入口。

新安装默认本机存储。模型及图文审核在后台配置，配置与验证完成前，生成或分发会按具体门禁保持阻断。安装成功与业务就绪是两个不同的检查结果。

## 4. 数据保存、存储与反向代理

### 持久化数据

| 主机数据目录内的位置 | 用途 |
| --- | --- |
| `config/` | 私有运行配置、应用密钥、数据库凭据文件和可选回读签名文件。 |
| `postgresql/` | 内置 PostgreSQL 的真实数据。 |
| `redis/` | 内置 Redis 的持久化数据。 |
| `storage/` | 本机存储模式的上传及生成文件。 |

其中 `config/runtime.json` 和应用数据库中的加密凭据相互关联。升级、恢复和迁移时必须保留原加密主密钥，不能用新生成的密钥替换原文件后宣称数据已恢复。不要删除数据目录、执行 `down -v` 或对已有业务库运行 `db push`。

本机存储目录只挂载到 API 和 Worker，两者必须访问同一真实目录。文件通过同源短期签名接口访问，不公开静态目录或匿名文件列表。

### 可选 S3

空安装可在后台“存储设置”配置自己的私有 S3 Bucket、Endpoint、区域和密钥，保存并验证后切换。调整已有安装前暂停上传与创建任务，并停止 Worker；配置和验证完成后重新启动 Worker，使运行中的模块加载配置。

有业务文件或在途任务时，首版会拒绝直接切换后端，不自动搬运、复制或删除原文件。此时先保留现有后端，再规划专项迁移。S3 签名地址须能被使用者浏览器访问，并按自己的站点来源设置 CORS；HTTPS 页面访问 HTTP 存储地址还受浏览器混合内容规则影响。本机模式不需要 S3 密钥或外部存储域名。

### 可选域名与 HTTPS

在自己的 DNS 与反向代理中配置域名，将整站转发到 Web 端口。应用不绑定一个固定域名，换域名无需重新构建 Web。Nginx / OpenResty 的 location 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3101;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

证书、域名及自动续期由自己的代理或 1Panel 管理。使用容器代理时，应按实际网络调整 upstream，`127.0.0.1` 只有在代理能通过主机本地端口访问 Web 时才适用。

浏览器统一请求当前站点的 `/api`，Web 再访问内部 API。代理必须覆盖并传递正确 Host 和协议；不要将浏览器请求指向 Docker 内的 `http://api:3100`，也不要用放开任意 Origin 来修复 Cookie 或跨站错误。新域名需要重新登录，旧域名 Cookie 不会迁移。HTTP IP 可完成安装与登录；公网长期访问可通过自己的代理启用 HTTPS。

## 5. 复用现有 PostgreSQL、Redis 或 1Panel 服务

这是高级部署方式。首版使用 PostgreSQL，不能仅把连接地址改成 MySQL 来替换数据库。先在现有实例中创建本应用专用数据库、普通应用角色和独立 Redis 前缀，避免与其他应用混用业务范围。

PostgreSQL 需要 `vector`、`btree_gist`、`pgcrypto`、`pg_trgm` 扩展及迁移权限。可由数据库管理员预装扩展，并授予应用账号对应数据库的连接权限和 `public` schema 的 `USAGE`、`CREATE` 权限；不要为方便长期授予超级用户。

在构建机可使用交互配置工具，为新外部数据库生成私有 `deploy/.env`：

```sh
node deploy/self-host.mjs configure
```

选择外部服务模式，填写容器内可达的 PostgreSQL、Redis 地址和认证信息，再将私有文件安全交付到运行主机。此工具不启动容器，也不修改数据库。已有安装应沿用原 `deploy/.env` 和完整应用密钥，不要重新运行初始化来替换它们。

外部服务模式在所有管理命令中带上环境文件和覆盖文件：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.external.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.external.yml up -d --no-build --pull never
```

覆盖文件禁用内置 PostgreSQL 和 Redis 服务。不要主动启用 `bundled-disabled` profile。若数据库由 1Panel 容器运行，应让 API、Worker 和 migrate 接入能访问该服务的 Docker 网络，或使用可达的主机地址；网络别名、端口及账号以自己的面板实际信息为准。不要公开数据库端口来代替正确的内部网络配置。

自定义覆盖文件按从左到右合并，后面的同名字段优先。维护镜像标签时应核对最终配置，防止可选回读文件的默认标签覆盖了自己的专用镜像标签。可用 `config --quiet` 验证语法；完整展开后的配置可能包含秘密，不应公开。

## 6. 可选同机自动回读

默认人工复核已经支持员工回填和管理员处理发布链接。自动回读不属于基础安装条件；“自动回读未启用（可选）”是正常提示。

准备与主系统兼容的 `qisheng/readback:$VERSION` 镜像，先交付并导入，再完成两个阶段：

```sh
docker compose -f deploy/compose.yml run --rm --no-deps --pull never -T bootstrap
docker compose -f deploy/compose.yml -f deploy/compose.readback.yml up -d --no-build --pull never readback
```

先运行 bootstrap，确保专用签名文件已经存在，再创建单文件只读挂载的回读容器。首次直接将覆盖文件一起启动，不应依赖 Docker 自动创建缺失的密钥文件。外部数据库、自定义网络或专用镜像覆盖文件也要按原顺序继续带上；最终镜像覆盖应放在能覆盖其默认标签的位置。

同机容器只读取独立签名文件，不挂载数据库密码或整个主配置目录，不暴露节点面板端口。它可以在线待命，同时保持自动回读关闭。

进入后台“发布复核与回读”，填写并保存自己的兼容公开 HTTPS 笔记详情接口和 Token，再用有权核查的样本确认可能产生的费用并执行验证，通过后按需启用。项目不附带供应商地址、服务账号、Token 或免费查询额度。接口及 Token 改变后，旧样本验证失效；更换接口主机时需重新输入 Token。

新的发布回填按约 24 小时后的计划查询；关闭时或没有到期任务时不查询供应商。技术失败、失效租约和证据不足按规则转交人工，不把供应商故障认定为员工未发布。完整协议和独立节点方式见[回读说明](../packages/xhs-api-collector/README.md)。

## 7. 服务检查与维护

以下示例为普通内置数据库安装。外部数据库或启用回读时，继续带上原环境文件及全部覆盖文件。

```sh
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail 100 api worker
docker compose -f deploy/compose.yml logs --tail 100 migrate
```

浏览器可检查 `/login`，以及 `/api/health/live`、`/api/health/ready`。HTTP 200 或容器显示 Running 不能代替业务验收：还应登录管理后台，检查模型和审核就绪状态、真实 Worker 消费者，并用自己的授权样本验证业务。

配置更换后按页面要求重启对应服务，例如重新加载 Worker 的审核或存储配置：

```sh
docker compose -f deploy/compose.yml restart worker
```

如果修改的是 Compose 或环境变量，则使用 `up -d --no-build --pull never` 重新创建受影响服务；单纯 `restart` 不更新容器环境。普通停止命令保留数据：

```sh
docker compose -f deploy/compose.yml stop
```

### 升级与恢复准备

1. 阅读目标版本的变更和迁移说明，确认当前数据结构与 Worker 的兼容范围。涉及维护迁移时，按说明停用旧服务，不与旧 Worker 混跑。
2. 由部署者安排并验证可恢复的数据保护方案。本项目不自动创建备份；数据库使用原生一致性导出，或停机后的完整备份，不能把运行中的数据目录复制件当作一致性备份。
3. 保留原数据目录、私有环境文件、加密主密钥和当前镜像版本。文件数据、数据库和配置需要作为同一安装恢复。
4. 在构建机准备新镜像，运行主机导入后，设置目标版本，使用原项目名、数据路径和覆盖文件执行该版本要求的更新。
5. 检查迁移退出结果、登录、存储文件读取及相关业务流程。迁移失败时先停止后续更新，保留原数据和日志，不通过清空数据库或修改迁移记录强行继续。

跨版本迁移后，旧镜像未必还能读取新结构。回退前先确认该版本的数据库兼容性；保留旧镜像本身不等于已经具备完整回退条件。

## 8. 常见问题处理

### 页面打不开或显示 502

确认浏览器使用正确的服务器 IP 和 `WEB_BIND_PORT`，检查云防火墙、主机防火墙及端口占用。用 `docker compose ... ps` 看 Web、API 和前置服务状态，再查看 API、migrate、数据库日志。反向代理显示 502 时，先验证它能直接访问 Web upstream；不要先调整模型或域名配置来修复一个容器未启动的问题。

### 出现 `No such image` 或启动时尝试拉取未知标签

检查所选 `QISHENG_VERSION` 与已导入镜像标签是否一致，四个主镜像是否齐全，以及覆盖文件是否覆盖了 image 字段。当前终端未设置版本时会退回默认 `local`。不要因为缺少镜像改为在运行主机现场构建。

### PostgreSQL 启动或迁移失败

先查看 PostgreSQL 与 migrate 日志。外部数据库要检查容器内连接地址、账号权限、四个扩展和 schema 权限。生产迁移不需要影子库。数据库里已有迁移历史时，应使用配套版本的迁移文件，不改写旧记录、不运行 `db push`、不删库重来。

### 如何重新取得安装凭证？能否重新安装覆盖管理员？

在原数据目录和原部署环境中重新运行[凭证命令](#3-网页初始化)。首次安装只允许空状态初始化，已有账号和组织不能通过再次提交向导覆盖。管理员密码与安装凭证分别管理；忘记登录密码时应走受控账号维护，不能删除 `runtime.json` 或数据库来解决。

### 登录后反复退出、跨域失败或 Cookie 无效

确认浏览器通过同一网站的 `/api` 访问接口，代理传递了正确 Host 和协议。检查是否在不同域名或 HTTP/HTTPS 之间反复切换、是否更换了原应用密钥，以及服务器时钟是否准确。换域名后重新登录；不要共享旧域名 Cookie 或开放任意 Origin。

### Worker 在运行，为什么门禁仍提示不能生成？

Running 只表示进程存在。尚未完成图文审核、模型或存储配置时，部分消费者不会启动；Worker 会定期重试尚未启动的模块。完成当前配置验证后按提示重启 Worker，并查看后台门禁的具体原因。一个普通 Worker 容器即可在同机消费生成和素材队列，不要求单独服务器；并发增加后仍需按实际负载评估容量。

### 普通聊天模型能代替 Embedding 吗？

不能把聊天接口直接当作向量接口。Embedding 是可选增强：未配置时使用本地基础检索，仍可完成企业资料与活动的基本流程。需要增强语义检索时，再配置实际提供 Embedding 接口的模型；文案、生图和图文审核仍按各自要求配置。

### 本机存储上传失败、图片打不开

检查磁盘可用容量、数据目录是否仍是原路径、API 与 Worker 是否共享同一目录，以及容器用户 UID 1000 是否能访问。短期签名过期时刷新页面重新取得地址，不要把签名链接当作永久公开图片链接。不要给整个数据目录开放匿名 Web 访问来修复权限问题。

### S3 保存成功，浏览器却无法加载文件

后台连接成功不代表使用者的浏览器能访问签名地址。检查 Endpoint、Bucket、区域、时钟、浏览器可达性、CORS 允许来源，以及 HTTPS 页面下的混合内容限制。分享错误信息时去掉 Access Key、Secret、带签名的 URL 查询参数和供应商返回的敏感内容。

### 修改存储或审核配置后为什么没立即生效？

运行中的处理模块保留已有连接和扫描器。按维护流程暂停相关业务并重启 Worker；初次配置时的自动重试不等于所有模块都支持热更新。已有业务文件时也不能直接从 LOCAL 切成 S3，详见[存储说明](#可选-s3)。

### 回读显示未启用，是否影响发布？

不影响员工回填和管理员人工复核，这是默认状态。只有需要自动查询公开笔记和指标时才部署并启用回读；节点在线与自动回读已启用分别表示两件事。开启后仍需等待新工作单到期，后台刷新不会立即查询全部历史笔记。

### 回读样本验证失败、节点离线或任务滞留

先核对笔记详情接口和 Token 是否为自己的有效配置、样本是否可访问、是否返回匹配笔记及必要指标。更换接口主机需重新填写 Token，配置变化需重新验证。样本失败也可能消耗供应商费用，不要连续尝试猜测接口。

同机节点离线时查看 `readback` 与 API 日志，检查签名文件是否由 bootstrap 创建、是否保留原主配置、节点能否访问内部 API。不要把供应商 URL 填成企声 API 地址。停止签名请求后约 90 秒会显示离线；原租约结果不明时会交由人工，避免自动重复付费。需要暂停回读时在后台关闭，保留人工复核流程。

### 集团用户或员工看不到预期数据

核对当前企业、账号角色、成员状态和任务参与资格。集团下属企业需要由管理员先创建；后台角色不会自动绑定员工身份。请按授权范围修正绑定，不要通过授予全局权限或直接改库绕过企业隔离。

### 磁盘紧张、进程被 OOM 终止

先查看主机可用内存和磁盘，再核对 Docker 重启次数、OOM 状态和日志。保留正在使用的镜像、数据目录和有效恢复资料；不要对共享主机执行无差别 `prune` 或删除目录。降低 Worker 并发或增加资源前，应依据实际队列和生成负载评估；首次能启动不代表具备持续存储及升级余量。

### 如何提交故障信息？

记录版本、架构、安装方式、发生时间、操作步骤、错误摘要，以及相关服务的少量日志。收集前后都检查脱敏，不上传：

- `.env`、`config/runtime.json`、数据库或用户文件。
- 密码、安装凭证、模型/S3/回读 Token、Cookie 或 Authorization 头。
- 带签名的文件地址、完整连接串、私人域名、内网拓扑及非公开成员资料。

截图使用虚构组织和演示账号；公开 Issue 中不张贴真实患者、客户、员工或业务数据。`docker compose config` 的完整结果可能包含秘密，只需先使用 `config --quiet` 检查语法。

## 9. 从源码在构建机制作镜像

首版需要在本机或独立构建机准备固定版本源码、Node.js **24.21.0** 和可运行 Linux amd64 构建的容器引擎。Dockerfile 会在 Linux 构建层安装项目锁定的 pnpm **12.6.0** 和依赖，宿主机不需要先运行 `pnpm install`。运行主机可只保留 Docker，不需要安装 Node.js。

在源码根目录执行：

```sh
VERSION='v0.1.1'
node deploy/self-host.mjs build "$VERSION"
```

脚本构建 API、Web、Worker、migrate 四镜像，Dockerfile 在 Linux 构建层内安装锁定依赖和编译，不复用宿主机 `node_modules`。Linux 构建机使用本机 Docker；维护者在 Windows 上使用已配置的 WSLC Linux 构建环境。

需要可选回读时另外执行：

```sh
node deploy/self-host.mjs build-readback "$VERSION"
```

验证镜像操作系统、架构和启动行为后，通过自己的镜像仓库或镜像归档显式交付到运行主机。例如，Linux Docker 构建机导出四镜像：

```sh
docker save -o qisheng-images.tar \
  "qisheng/api:$VERSION" "qisheng/web:$VERSION" \
  "qisheng/worker:$VERSION" "qisheng/migrate:$VERSION"
sha256sum qisheng-images.tar
```

回读镜像可单独导出。Windows WSLC 与其他 Docker Engine 的镜像存储独立，应使用对应引擎的导出命令，不假设标签自动共享。交付归档和校验值后，回到本文[镜像导入步骤](#已有构建镜像的用户)。构建成功仍需自己的模型、审核、数据与外部样本验收，不能代替生产业务检查。
