# Sprint 8 SaaS 规模基线

执行：

```bash
pnpm benchmark:sprint8-scale
```

脚本仅允许连接 `dev_xhs_agentic`，会创建一个固定 ID 的专用临时租户，装载：

- 50 家企业；
- 10,000 个独立企业成员席位；
- 10,000 个活动；
- 100,000 个员工生成工作项；
- 1,000 条审计记录。

它会预热并重复采样活动首屏、客户搜索、集团聚合、工作项首屏、500 条 CSV 批次和审计时间线，要求常用查询 p95 小于 800ms；同时测量 100 人活动的快照和工作项持久化时间，确认请求阶段不执行模型生成。

报告写入 `.artifacts/sprint8-scale-report.json`，包含 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`。无论成功或失败，专用基准租户都会按精确 Tenant ID 清理，不影响其他开发数据。

完整 API + Redis + Worker + 私有对象存储 的 100 人链路仍使用：

```bash
pnpm benchmark:pilot-local-100
```

该报告现在单独记录 `latencyMs.campaignRequest`，并以 800ms 为请求入队门禁；实际生成时间继续单独统计。
