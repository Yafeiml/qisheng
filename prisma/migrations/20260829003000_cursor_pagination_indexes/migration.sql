-- Compound indexes back deterministic created-at/id keyset pagination on growing lists.
CREATE INDEX "tenants_created_at_id_idx" ON "tenants"("created_at", "id");
CREATE INDEX "enterprise_memberships_enterprise_id_created_at_id_idx"
ON "enterprise_memberships"("enterprise_id", "created_at", "id");
CREATE INDEX "audit_logs_enterprise_id_created_at_id_idx"
ON "audit_logs"("enterprise_id", "created_at", "id");
CREATE INDEX "campaigns_tenant_id_enterprise_id_created_at_id_idx"
ON "campaigns"("tenant_id", "enterprise_id", "created_at", "id");
CREATE INDEX "generation_runs_created_at_id_idx" ON "generation_runs"("created_at", "id");
CREATE INDEX "publish_submissions_tenant_id_status_submitted_at_id_idx"
ON "publish_submissions"("tenant_id", "status", "submitted_at", "id");
