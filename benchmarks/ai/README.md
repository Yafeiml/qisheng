# AI 基准测试

`@xhs-agentic/ai-gateway` 提供两类 Phase 0 工具：

```bash
./scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway benchmark:dry-run
./scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway benchmark:pilot-synthetic
./scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway benchmark:images ./benchmarks/ai/image-manifest.json
```

`benchmark:dry-run` 只验证 Provider 注册、策略冻结、重试、主备切换、调用记录和感知哈希链路。输出包含 `synthetic: true`，禁止用于成本、质量或供应商决策。

启动 API 与 Worker 后，可以执行完整的本机 PostgreSQL + BullMQ + 私有 S3 兼容对象存储 100 人负载基准：

```bash
./scripts/dev/pnpm.sh benchmark:pilot-local-100
```

它会建立独立的开发租户和 100 个员工席位，报告写入 `.artifacts/pilot-local-100-report.json`。验收同时检查：

- 100 个工作项全部成功且无最终失败；
- SHA-256 和 dHash 各 100 个唯一值；
- 100 个私有存储对象都能通过签名 URL 下载，且下载字节与数据库 checksum 一致；
- 额度最终为 consumed 100、reserved 0；
- 直接重放一个成功工作项，内容、图片、任务、消费账本与额度必须保持不变；
- 活动创建请求只完成校验、快照和入队，耗时必须低于 800ms；
- P50/P95、工作项重试量和模型调用审计数量写入报告。

基准客户端会为写操作发送唯一幂等键，并等待异步素材入库达到 READY 后再创建活动；模型调用数量和对象存储键从本机数据库核对，不要求企业活动 DTO 暴露平台内部字段。

该测试会保留基准租户用于审计，且仍是 synthetic，不代表真实模型质量、成本或供应商稳定性。

真实图片测试 Manifest 格式：

```json
{
  "benchmarkId": "provider-a-image-model-20260828",
  "synthetic": false,
  "entries": [
    {
      "employeeMembershipId": "membership-001",
      "imagePath": "./outputs/001.png",
      "provider": "provider-a",
      "model": "image-model",
      "latencyMs": 8420,
      "cost": 0.12
    },
    {
      "employeeMembershipId": "membership-002",
      "imagePath": "./outputs/002.png",
      "provider": "provider-a",
      "model": "image-model",
      "latencyMs": 7910,
      "cost": 0.12
    }
  ]
}
```

真实测试至少包含 100 个不同 EnterpriseMembership，并保存模型、Prompt 模板版本、Seed、尺寸、延迟、成本和失败原因。感知哈希只负责发现候选重复图片，生产阈值还需结合视觉 Embedding 和人工复核确定。

## 真实 Provider 生成基准

工程接入完成后，使用独立的测试 Key 执行：

```bash
PILOT_BENCHMARK_BASE_URL=https://provider.example/v1 \
PILOT_BENCHMARK_API_KEY=replace-me \
PILOT_BENCHMARK_TEXT_MODEL=text-model-id \
PILOT_BENCHMARK_IMAGE_MODEL=image-model-id \
PILOT_BENCHMARK_INPUT_COST=1.25 \
PILOT_BENCHMARK_OUTPUT_COST=5 \
PILOT_BENCHMARK_IMAGE_COST=0.12 \
PILOT_BENCHMARK_COST_CURRENCY=CNY \
./scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway benchmark:real-provider
```

正式运行前可以在同一组环境变量中增加 `PILOT_BENCHMARK_PREFLIGHT_ONLY=true`。预检只验证配置、凭据引用、HTTPS 地址、成本口径和运行参数，不请求供应商，也不打印 API Key。

仅当 Provider 位于本机回环地址时，可以显式设置 `PILOT_BENCHMARK_ALLOW_HTTP=true` 使用 HTTP；远程 Provider 仍应使用 HTTPS。该开关不改变凭据脱敏规则。

默认强制至少 100 名成员、100% 成功和至少 100 份成功图文包。`PILOT_BENCHMARK_ALLOW_SMALL=true` 只允许低成本冒烟，不能通过正式验收；成本字段必须完整，除非显式设置 `PILOT_BENCHMARK_ALLOW_UNKNOWN_COST=true`，而未知成本报告同样不能通过验收。

每次运行会在独立 `.artifacts/ai-real-benchmark-*` 目录中写入：

- `report.json`：自动门禁、成功率、分阶段成本、调用/重试、失败分类、P50/P95、Provider 原图尺寸分布、实际最高 dHash 相似度和重复候选；
- `results.json`：母版及每位成员的文案、图片、Seed、Provider 原始尺寸、归一化交付尺寸、SHA-256、dHash 和调用证据；
- `image-manifest.json`：供 `benchmark:images` 二次分析；
- `review.html`：本地图片与对应文案的人工视觉复核索引；
- `manual-review.template.json`：人工复核模板。

真实配图提示词强制禁止图片内文字、医疗结论、Logo、二维码、界面、效果对比和患者个人信息，并按 Seed 分流构图。基准与生产 Worker 使用同一规则将 Provider 原图归一化为 `1080×1440` PNG；checksum、dHash、`review.html` 和最终验收均针对归一化后的实际交付物。

自动门禁通过后打开 `review.html`。如果全量认可，只需填写复核人、勾选责任确认并点击“一键签署并保存 JSON”；尚未单独标记的条目会统一记为 PASS。发现异常时，可先在对应卡片选择问题并记录 FAIL。页面会生成完整的 `manual-review.json`，无需手工编辑 100 条记录。将文件保存到本次基准目录后执行：

```bash
./scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway \
  benchmark:verify-real-provider .artifacts/ai-real-benchmark-具体时间
```

验收器会重新读取全部图片，核对 SHA-256、dHash、100 个唯一成员、自动门禁和人工复核，并写出 `acceptance-report.json`。只有其中 `accepted: true` 才能把 Sprint 标记为“真实 Provider 已验证”。API Key 始终只从环境变量读取，不进入任何报告。
