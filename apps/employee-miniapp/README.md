# 员工微信小程序（可选）

默认自托管员工入口是 Web `/employee`，无需微信账号或 AppID。此目录是可选的原生微信客户端，直接调用员工 API，员工与管理 Token 的 audience 隔离。普通员工只查看本人有效成员身份对应的任务、图文、历史与回填。

## 接入前配置

1. 使用自己的小程序账号和开发者权限导入 `apps/employee-miniapp`。仓库 `project.config.json` 为 `touristappid`，只是占位，不是可发布的真实 AppID。
2. 在本地项目配置填写自己的 AppID；AppSecret 只配置到服务端，不写入小程序。`project.private.config.json` 及其他本地私有配置不提交。
3. 将 `utils/api.ts` 的 `API_BASE_URL` 从 `https://api.example.com/api` 换成自己部署的 HTTPS API 前缀。`example.com` 不是可用服务。
4. 在微信公众平台配置自己的 request、下载等合法域名，并确认 HTTPS 证书与实际图片交付地址。
5. 如需手机号短信登录，平台配置自己的短信通道；网页账号密码注册和成员邀请不依赖该通道。

小程序沿用员工手机号请求验证码、候选成员和绑定 API。不能用未验证手机号绑定已有员工身份，也不能因为拥有后台账号就访问他人任务。开发验证码只用于明确的非生产模式，不能作为正式员工认证方式。

## 任务操作

员工领取任务、确认当前版本真实、复制文案与保存图片、手动发布后粘贴链接。开放前内容不提前交付。复制和下载前重新取得当前版本许可，授权变化或成员停用不能继续沿用旧缓存权限。

CAP、短信与新任务通知按服务端实际配置显示。通知默认关闭；微信一次性订阅只由员工主动点击触发，拒绝或失败不影响任务操作。供应商凭据与 OpenID 不由客户端任意指定。真机授权、送达和微信发布审核须使用自己的应用完成验收。

## 本地联调

在仓库根目录统一启动：

```sh
bash scripts/dev/pnpm.sh dev:all
```

平台管理：<http://localhost:3101/platform>；企业管理：<http://localhost:3101/console>；默认员工网页：<http://localhost:3101/employee>。

开发工具可临时连接本地 API `http://127.0.0.1:3100`，本地调试时才关闭工具的合法域名校验；预览、上传前恢复自己的 HTTPS 地址与校验。手机上的 loopback 指手机自身，真机不能直接使用电脑的 `127.0.0.1`。

可选 Windows 调试镜像脚本 `scripts/dev/sync-miniapp-windows.sh` 需要 WSL 的 `wslpath` 与 `rsync`。它保留目标已存在的项目配置，不能假定同步源码会覆盖本地 AppID；修改后核对运行副本并刷新开发者工具。无需镜像时可直接导入当前源码目录。

## 校验与验证码产物

```sh
pnpm --filter @xhs-agentic/employee-miniapp typecheck
pnpm miniapp:captcha
```

验证码客户端来源为 `packages/captcha-client`，生成文件附带的第三方许可必须保留。正式小程序仍需自己的隐私协议、应用审核与真实供应商验证，不能把本地 synthetic 内容当作真实平台能力。
