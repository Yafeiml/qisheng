# 参与企声发布

欢迎提交可复现的问题、文档修正和范围明确的改进。新增大功能或改变权限、数据结构之前，请先在 Issue 中说明问题与拟议行为。

## 提交问题

请提供版本、浏览器／部署环境、复现步骤、预期与实际结果，以及脱敏日志。截图使用虚构或已获公开授权的数据。安全问题按 [SECURITY.md](SECURITY.md) 私密反馈。

## 本地开发

使用 Node.js 24.21.0、pnpm 12.6.0。准备独立开发数据库、Redis 命名空间与存储，参考根目录 `.env.example` 配置自己的开发环境，不复用其他安装的业务数据和密钥。

```sh
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm -r --filter './packages/**' --if-present build
pnpm exec prisma migrate deploy
```

数据库扩展和网页安装见[部署文档](docs/deployment.md)。验证正式初始化时保持 `ENABLE_DEV_AUTH=false`，不要先运行会创建演示账号的开发 seed。

以下命令分别在三个终端运行：

```sh
pnpm dev:api
pnpm dev:admin
pnpm dev:worker
```

Web 默认 `http://localhost:3101`，运营工作台 `/console`、系统设置 `/platform`、员工入口 `/employee`。已有本地容器与工具链的维护者可使用 `bash scripts/dev/pnpm.sh dev:all`，该便利脚本不是普通 Docker 用户的安装前提。

## 验证与 Pull Request

围绕修改运行相应测试；涉及权限、凭据、计费请求或数据状态时需补充回归验证。页面修改检查桌面和窄屏、表单与按钮状态。集成测试使用隔离数据库，不对业务数据库运行测试清理逻辑。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
pnpm source:prepare
```

部分集成测试需要数据库、Redis、隔离数据或外部服务。在 PR 中说明实际执行和未执行的检查，不把模拟结果写成真实供应商验收。不要自动触发模型、审核或回读的付费调用。

PR 描述说明问题、最终行为和验证结果。保持工具链与锁文件版本。数据库迁移需说明兼容性、已有数据影响及恢复限制。

## 贡献许可

除非在贡献前另有明确书面约定，向本项目有意提交并被接收的原创贡献依照 Apache License 2.0 第 5 条提供。请确认有权提交代码、文档和素材，保留第三方许可与归属，不提交无来源图片、客户数据或专有代码。

Apache-2.0 允许依照许可进行商业使用及闭源衍生。本项目不要求转让版权，贡献者保留其原创贡献的版权。第三方代码的许可条件继续适用。
