# P-014 小红书真实公开链接评测

该执行包用于冻结生产 `VerificationPolicy`，直接复用线上 `HttpPublicationVerificationAdapter`、链接清洗和图文评分器。Fixture、mock、synthetic、本机回环 Provider 或 HTTP 冒烟结果都不能通过正式验收。

## 1. 准备样本

复制 `p014-manifest.template.json`，替换为真实任务原文、员工独立图片指纹和真实小红书公开链接。正式评测至少需要：

- 30 条样本，其中至少 10 条应匹配、10 条明确不匹配、3 条暂不可访问。
- 覆盖长链、短链、查询参数、分享文本、合理改写、图片压缩、裁剪、水印、无关内容、暂不可访问和不同发布账号。
- 至少一组 `canonicalGroup` 同时包含同一帖子的短链和长链/参数变体。
- 至少两个候选策略；正式候选必须要求员工独立图片匹配。

API Key 只通过环境变量传入，不得写进 Manifest 或任何报告。

## 2. 无请求预检

```bash
P014_BENCHMARK_PREFLIGHT_ONLY=true \
P014_BENCHMARK_ENDPOINT=https://provider.example/v1/resolve \
P014_BENCHMARK_API_KEY=replace-me \
P014_BENCHMARK_PROVIDER=provider-code \
pnpm benchmark:p014 benchmarks/publication/p014-manifest.json
```

预检会验证样本数量、场景覆盖、真实链接格式、供应商声明、候选策略和质量门禁，不会请求供应商，也不会输出 API Key。

## 3. 执行真实评测

```bash
P014_BENCHMARK_ENDPOINT=https://provider.example/v1/resolve \
P014_BENCHMARK_API_KEY=replace-me \
P014_BENCHMARK_PROVIDER=provider-code \
P014_BENCHMARK_TIMEOUT_MS=15000 \
P014_BENCHMARK_CONCURRENCY=3 \
pnpm benchmark:p014 benchmarks/publication/p014-manifest.json
```

输出目录包含：

- `manifest.json`：本次冻结的脱敏样本和候选策略。
- `results.json`：供应商证据、Canonical Key、延迟和每个候选策略的线上同源评分。
- `report.json`：可获取率、短长链一致性、误通过、误拒绝、人工复核率、推荐候选和生产评分器版本。
- `review.html`：人工逐项复核和一键签署页面。
- `manual-review.template.json`：机器可读复核模板。

`P014_BENCHMARK_ALLOW_HTTP=true` 和 `P014_BENCHMARK_ALLOW_SMALL=true` 仅供低成本冒烟；报告会明确标记为不可用于生产验收。

比较多个公开内容供应商时，应使用同一份 Manifest 分别执行，每个供应商使用独立 `benchmarkId` 和输出目录，再比较可获取率、延迟、错误分类与相同评分器下的策略结果。不得把不同样本集的结果直接当作供应商优劣结论。

## 4. Windows 浏览器复核

工作区位于 WSL 时，使用项目提供的窄目录微型服务：

```bash
node scripts/dev/serve-review.mjs .artifacts/p014-具体目录 18765
```

Windows 浏览器打开 `http://localhost:18765/review.html`。服务只暴露本次评测目录，并且唯一写入口只能生成该目录中的 `manual-review.json`。

页面允许标记异常样本；其余样本可在确认责任后一次性签署为通过。人工签署不能覆盖自动门禁失败。

## 5. 最终验收

```bash
pnpm benchmark:p014:verify .artifacts/p014-具体目录
```

验收器重新解析 Manifest 和 Results、重算全部指标、核对 SHA-256、HTTPS/非本机 Provider、自动门禁、签署人、样本完整性和获批策略，最后写入 `acceptance-report.json`。

取得 `accepted: true` 后，SaaS 平台管理员还需要在“参数设置 → 发布验真”选择该文件或粘贴原文并填写登记原因。服务端会再次校验报告，并要求其中的 Provider、Endpoint、评分器版本、策略版本、文本阈值、图片阈值和人工复核灰区与当前运行配置完全一致。登记成功后生成不可变 `PublicationVerificationPolicyEvidence`；修改运行配置会使旧证据自动失配，但不会删除历史记录。

只有验收报告通过、证据登记成功且 `pnpm production:audit` 的 P-014 门禁变为 `READY`，才能关闭 P-014 并冻结生产 `VerificationPolicy`。
