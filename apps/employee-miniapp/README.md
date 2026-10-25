# 员工微信小程序（可选）

默认自托管员工入口是 Web `/employee`，无需微信账号或 AppID。此目录是可选的原生微信客户端，连接部署者自己的服务；员工与管理 Token 的 audience 隔离。普通员工只查看本人有效成员身份对应的任务、图文、历史与回填。

完整的[自部署、导入、预览和排障说明](https://github.com/Yafeiml/qisheng/blob/v0.1.2/docs/miniapp.md)面向部署者；业务流程见[操作说明](https://github.com/Yafeiml/qisheng/blob/v0.1.2/docs/user-guide.md)，主服务安装见[部署说明](https://github.com/Yafeiml/qisheng/blob/v0.1.2/docs/deployment.md)。在线链接也适用于独立导出的小程序源码包。

直接下载 [v0.1.2 独立小程序源码 ZIP](https://github.com/Yafeiml/qisheng/releases/download/v0.1.2/qisheng-employee-miniapp-v0.1.2.zip)；先查看同 Release 的 [SHA256SUMS.txt](https://github.com/Yafeiml/qisheng/releases/download/v0.1.2/SHA256SUMS.txt)，比对文件 SHA-256 后解压。保留随包 `LICENSE`、`NOTICE` 和第三方许可，再在解压目录根配置 `config.ts` 与 `project.config.json`。

## 接入前配置

建议主服务与小程序使用同一固定版本。v0.1.2 默认使用管理员创建的员工网页账号密码登录，不开放注册，也不要求短信或微信身份登录。

在完整仓库根目录运行，先替换 AppID、HTTPS 地址和新的输出目录：

```sh
node scripts/miniapp/export.mjs --app-id "替换为自己的AppID" --api-base "https://qisheng.example.com/api" --output "../qisheng-employee-v0.1.2"
```

导出工具生成独立项目的 `config.ts` 和 `project.config.json`，不会替你上传微信。使用微信开发者工具导入输出目录；`example.com` 是示例地址，仓库的 `touristappid` 也是未配置模板，均须替换。原生编译、预览和真机验收须使用自己的有效 AppID 完成。

也可在独立源码副本中手动设置：

- `config.ts`：`miniappConfig.apiBaseUrl` 填自己的 HTTPS API 前缀，通常是企声发布站点地址加 `/api`；`smsLoginEnabled` 默认 `false`。
- `project.config.json`：`appid` 填自己的真实小程序 AppID。检查开发者工具项目详情及本地 `project.private.config.json`，防止旧私有设置覆盖。
- 微信公众平台：配置请求域名、实际图片下载域名、用户隐私保护指引及所需开发/体验权限。

AppSecret、模型密钥、数据库密码和员工密码不写进小程序。AppSecret 仅在需要微信订阅通知时由部署者在服务端加密配置；主账号密码登录不依赖它。

## 任务操作

员工领取任务、确认当前版本真实、复制文案与保存图片、手动发布后粘贴链接。开放前内容不提前交付。复制和下载前重新取得当前版本许可，授权变化或成员停用不能继续沿用旧缓存权限。

员工在小红书中手动发布，小程序不会代为发帖。实例配置区分会话，切换服务后重新登录，不复制旧令牌。

需要手机号验证码入口时，在导出命令加 `--sms-login`，或将 `miniappConfig.smsLoginEnabled` 改为 `true`；同时配置并验证自己的短信服务。验证码只绑定已导入成员的本人身份，调试验证码不能作为正式员工认证方式。

微信新任务通知另在服务端配置，默认关闭。AppID、AppSecret、模板、环境须与自己的微信应用一致。一次性订阅只由员工主动点击触发，拒绝或失败不影响任务；供应商凭据与 OpenID 不由客户端任意指定。真机授权、送达和微信发布审核须使用自己的应用完成验收。

## 本地联调

维护者需要启动整套本地服务时，先准备开发数据库等环境，再在完整仓库根目录运行：

```sh
bash scripts/dev/pnpm.sh dev:all
```

平台管理：<http://localhost:3101/platform>；企业管理：<http://localhost:3101/console>；默认员工网页：<http://localhost:3101/employee>。

这不是导入小程序的前置步骤。仅维护者本地调试可临时使用本地 API 并关闭工具的合法域名校验；预览、上传前恢复自己的 HTTPS 地址与校验。手机上的 loopback 指手机自身，真机不能直接使用电脑的 `127.0.0.1`。

可选 Windows 调试镜像脚本 `scripts/dev/sync-miniapp-windows.sh` 需要 WSL 的 `wslpath` 与 `rsync`，保留目标已存在的项目配置，但会同步客户端源码。不要用它覆盖已经配对的独立项目；普通部署者直接导入导出目录即可。

## 校验与验证码产物

```sh
pnpm --filter @xhs-agentic/employee-miniapp typecheck
pnpm miniapp:captcha
```

以上检查需先在完整仓库安装锁定依赖。验证码客户端来源为 `packages/captcha-client`，生成文件附带的第三方许可必须保留。源码压缩包不是已编译、已上传或通过微信审核的制品；正式使用仍需自己的隐私指引、应用审核和真实供应商验收。
