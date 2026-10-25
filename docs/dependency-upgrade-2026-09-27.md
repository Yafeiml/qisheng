# 2026-09-27 依赖升级

按 npm 官方仓库的正式版本升级各 workspace，固定精确版本并更新锁文件。生产服务器未执行发布、迁移或版本切换。

## 主要版本

| 组件 | 当前版本 |
| --- | --- |
| Node.js / pnpm | 24.21.0 LTS / 12.6.0 |
| Next.js / React | 16.3.6 / 19.3.0 |
| NestJS / Swagger / Nest CLI | 12.1.0 / 12.0.2 / 12.0.7 |
| Prisma CLI、Client、PostgreSQL Adapter | 7.10.0 |
| TypeScript 默认编译器 | 7.0.2 |
| Vitest / Playwright | 5.0.2 / 1.63.0 |
| Biome / tsx | 2.5.14 / 4.23.15 |
| BullMQ / Undici | 6.3.9 / 8.11.2 |
| AWS S3 SDK | 3.1141.0 |
| Nodemailer / class-validator | 10.0.10 / 0.15.1 |
| Noble Hashes / file-type / Mammoth | 2.4.0 / 22.1.1 / 1.13.0 |

未列出的直接依赖已逐一查询；原本就是最新版的依赖保留。间接依赖按上游支持的范围更新，不能把所有传递依赖强制改成不同主版本。

## 明确保留的兼容版本

- Prisma 的 `latest` 指向 `8.0.0-rc.17`，属于候选版；CLI 和 Client 统一使用最新正式版 7.10.0。
- Prisma 7 的安装检查尚未接受 Node 26，因此采用最新 LTS Node 24.21.0，Node 类型使用对应的 24.19.0。本地工具链和 Docker 基础镜像保持一致，基础镜像仍固定 SHA-256。
- NestJS Swagger 的编译插件需要 TypeScript JavaScript Compiler API，当前支持 TypeScript 5/6，API 构建使用最新 6.x 的 6.0.3。OpenAPI 生成器当前要求 TypeScript 5，放在 contracts workspace 内使用 5.9.3。Web、Worker 和其他共享包使用 7.0.2，不通过忽略 peer 警告冒充兼容。

## 必要适配

1. Prisma 连接配置迁入 `prisma.config.ts`，新建共享数据库包，统一 PostgreSQL adapter、UTC 会话和连接池。应用、测试、种子与维护脚本使用同一客户端入口。没有修改既有数据库迁移历史。
2. 发布构建复制 Prisma CLI 配置，并把生成客户端放在打包后的对应 Prisma 运行库旁，兼容 pnpm 的独立依赖目录。镜像打包前增加断网的运行库加载检查，缺少运行依赖时停止，不会继续上传。迁移核验使用 `pg`，可在升级前后 API 镜像中执行；Worker 预检脚本随版本更新并兼容旧 Prisma 回滚目标。
3. pnpm 的覆盖版本和安装脚本许可从 package.json 迁入 pnpm-workspace.yaml，使用新版部署打包方式，移除旧的 `--legacy` 参数。构建使用项目锁定的 Node。
4. TypeScript 改用 NodeNext 模块解析；Vitest 5 保留测试串行语义、明确测试环境，并把 Node 原生测试交还给 Node 测试运行器。
5. 更新 Noble Hashes 入口、小程序验证码产物、邮件库返回类型和 OpenAPI 产物。Windows 浏览器采集包从项目清单读取版本，避免再次写死旧版本。
6. 修复间接依赖漏洞：Prisma Studio 的 mysql2 固定为 3.24.4；OpenAPI 工具链的 js-yaml 固定为 4.3.2。Cheerio 的 encoding-sniffer 升至 1.0.2，移除已弃用的 whatwg-encoding，并验证中文 UTF-8、GB18030 及跨数据块解码。
7. TypeScript 的 `.tsbuildinfo` 缓存从发布快照和源码指纹中排除；真正的源码变化仍会中止发布。临时目录不参加源代码格式检查。

## 验证和提醒

- 全 workspace 类型检查、应用构建和 314 个 OpenAPI 操作的契约检查通过。
- 独立 PostgreSQL 测试容器中 747 项业务与集成测试通过，结束后移除测试容器；未复制开发库数据或生产数据。
- 58 项部署/SSR 脚本测试通过；另外启用真实临时 PostgreSQL 的迁移事务、并发锁和兼容性检查，6 项通过。
- 17 项桌面及窄屏页面测试通过，覆盖生成风格抽屉、复选框、选择器、保存失败、回读额度及通知设置。请求使用测试数据，不发送真实邮件或付费模型请求。
- 包含开发依赖的 `pnpm audit` 为 0 个已知漏洞，peer 检查无冲突。
- 在独立源码快照中构建 API、Web、Worker、回读节点四种镜像。API/Worker 容器通过 Prisma 7 访问临时 PostgreSQL，事务查询与 UTC 会话正常；回读面板在隔离网络中通过 HTTP 健康检查。构建和检查均在本机执行。

最新版 pg 8 在同一事务连接上出现并行查询时仍会给出弃用提示，Prisma 7 驱动路径会触发它。当前集成测试通过；这不是库版本落后，也没有全局屏蔽该提示。后续升级 pg 9 前需要处理同一连接的查询调度。Prisma 可能显示升级到 8 RC 的提示，不应因此安装候选版。

## 当前交付

这些版本说明是对应日期的兼容记录，当前版本以锁文件为准。安装和升级统一见[自托管安装](../deploy/README.md)。在本机或构建机生成镜像，运行机只使用明确版本的已有镜像执行迁移和启动。修改依赖后需要重新构建相应镜像，不能继续使用旧依赖产物。
