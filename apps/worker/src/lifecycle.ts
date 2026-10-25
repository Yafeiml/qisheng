import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  postgresConnectionStringWithUtcSession,
  writeStructuredLog,
} from "@xhs-agentic/observability";
import { Pool } from "pg";
import { EmployeeNotificationProcessor } from "./employee-notification-worker";
import { startGenerationLabWorker } from "./generation-lab-worker";
import { type GenerationWorkerHandle, startGenerationWorker } from "./generation-worker";
import {
  type MaterialIngestionWorkerHandle,
  startMaterialIngestionWorker,
} from "./material-ingestion-worker";
import { assertProductionWorkerBootstrapPolicy } from "./production-bootstrap-policy";

const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
assertProductionWorkerBootstrapPolicy();

const intervalMs = positiveInteger(process.env.LIFECYCLE_INTERVAL_MS ?? "30000");
const runOnce = process.argv.includes("--once");
const databaseUrl = postgresConnectionStringWithUtcSession(requiredEnv("DATABASE_URL"));
process.env.DATABASE_URL = databaseUrl;
const database = new Pool({ connectionString: databaseUrl, max: 2 });
const employeeNotifications = new EmployeeNotificationProcessor(database);
let stopping = false;

async function reconcileLifecycle(): Promise<Record<string, number>> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('xhs-agentic:campaign-lifecycle-v1'))",
    );
    const resumedParticipations = await client.query<{
      enterprise_id: string;
      id: string;
      membership_id: string;
      tenant_id: string;
    }>(`
      UPDATE membership_participations
      SET status = 'PARTICIPATING',
          effective_from = NULL,
          effective_until = NULL,
          version = version + 1,
          updated_at = NOW()
      WHERE status = 'PAUSED'
        AND effective_until IS NOT NULL
        AND effective_until <= NOW()
      RETURNING id, tenant_id, enterprise_id, membership_id
    `);
    for (const participation of resumedParticipations.rows) {
      await client.query(
        `
          INSERT INTO audit_logs (
            id, tenant_id, enterprise_id, actor_type, action, resource_type,
            resource_id, reason, state_after, created_at
          ) VALUES (
            gen_random_uuid()::text, $1, $2, 'SYSTEM',
            'membership.participation.resume', 'MembershipParticipation', $3,
            '暂停期限已到，系统自动恢复任务参与',
            jsonb_build_object('status', 'PARTICIPATING', 'membershipId', $4::text), NOW()
          )
        `,
        [
          participation.tenant_id,
          participation.enterprise_id,
          participation.id,
          participation.membership_id,
        ],
      );
    }
    const activeCampaigns = await client.query(`
      UPDATE campaigns
      SET status = 'ACTIVE', updated_at = NOW()
      WHERE status = 'APPROVED'
        AND visible_at <= NOW()
        AND expires_at > NOW()
    `);
    const availableTasks = await client.query(`
      UPDATE distribution_tasks AS task
      SET status = 'AVAILABLE', updated_at = NOW()
      FROM campaigns AS campaign
      WHERE task.campaign_id = campaign.id
        AND task.tenant_id = campaign.tenant_id
        AND campaign.status IN ('APPROVED', 'ACTIVE')
        AND task.status = 'LOCKED'
        AND task.visible_at <= NOW()
        AND task.expires_at > NOW()
    `);
    const expiredTasks = await client.query(`
      UPDATE distribution_tasks
      SET status = 'EXPIRED', expired_at = COALESCE(expired_at, NOW()), updated_at = NOW()
      WHERE expires_at <= NOW()
        AND status IN ('LOCKED', 'AVAILABLE')
    `);
    const completedCampaigns = await client.query(`
      UPDATE campaigns AS campaign
      SET status = 'COMPLETED', updated_at = NOW()
      WHERE campaign.status IN ('APPROVED', 'ACTIVE')
        AND campaign.audience_count > 0
        AND NOT EXISTS (
          SELECT 1
          FROM distribution_tasks AS task
          WHERE task.campaign_id = campaign.id
            AND task.tenant_id = campaign.tenant_id
            AND task.status <> 'COMPLETED'
        )
    `);
    const expiredCampaigns = await client.query(`
      UPDATE campaigns
      SET status = 'EXPIRED', updated_at = NOW()
      WHERE status IN ('APPROVED', 'ACTIVE')
        AND expires_at <= NOW()
    `);
    await client.query("COMMIT");
    return {
      activeCampaigns: activeCampaigns.rowCount ?? 0,
      resumedParticipations: resumedParticipations.rowCount ?? 0,
      availableTasks: availableTasks.rowCount ?? 0,
      completedCampaigns: completedCampaigns.rowCount ?? 0,
      expiredCampaigns: expiredCampaigns.rowCount ?? 0,
      expiredTasks: expiredTasks.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function start(): Promise<void> {
  let generationWorker: GenerationWorkerHandle | undefined;
  let generationLabWorker: Awaited<ReturnType<typeof startGenerationLabWorker>> | undefined;
  let materialIngestionWorker: MaterialIngestionWorkerHandle | undefined;
  let activeTick: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      stopping = true;
      clearInterval(timer);
      await Promise.allSettled([employeeNotifications.close(), activeTick]);
      await Promise.allSettled([
        generationWorker?.close(),
        generationLabWorker?.close(),
        materialIngestionWorker?.close(),
        database.end(),
      ]);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    })();
    return shutdownPromise;
  };
  const onSignal = () => void shutdown();
  try {
    if (runOnce) {
      const result = await reconcileLifecycle();
      workerLog("info", "lifecycle.reconciled", result);
      workerLog("info", "employee-notifications.reconciled", await employeeNotifications.run());
      await shutdown();
      return;
    }

    const reconcileTick = async (): Promise<void> => {
      if (stopping) return;
      await Promise.all([
        !generationWorker && process.env.GENERATION_EXECUTION_MODE === "queue"
          ? startGenerationWorker()
              .then((handle) => {
                generationWorker = handle;
              })
              .catch((error) =>
                workerLog("error", "worker.component.start.error", {
                  component: "generation",
                  error,
                }),
              )
          : undefined,
        !materialIngestionWorker && process.env.MATERIAL_INGESTION_EXECUTION_MODE !== "disabled"
          ? startMaterialIngestionWorker()
              .then((handle) => {
                materialIngestionWorker = handle;
              })
              .catch((error) =>
                workerLog("error", "worker.component.start.error", {
                  component: "material",
                  error,
                }),
              )
          : undefined,
        !generationLabWorker
          ? startGenerationLabWorker()
              .then((handle) => {
                generationLabWorker = handle;
              })
              .catch((error) =>
                workerLog("error", "worker.component.start.error", { component: "lab", error }),
              )
          : undefined,
      ]);
      if (stopping) return;
      try {
        const result = await reconcileLifecycle();
        if (Object.values(result).some((count) => count > 0)) {
          workerLog("info", "lifecycle.reconciled", result);
        }
      } catch (error) {
        workerLog("error", "lifecycle.error", { error });
      }
      if (!stopping) {
        try {
          const result = await employeeNotifications.run();
          if (Object.values(result).some((count) => count > 0)) {
            workerLog("info", "employee-notifications.reconciled", result);
          }
        } catch {
          workerLog("error", "employee-notifications.error", { code: "NOTIFICATION_TICK_FAILED" });
        }
      }
    };
    const tick = (): Promise<void> => {
      if (stopping) return Promise.resolve();
      if (activeTick) return activeTick;
      activeTick = reconcileTick().finally(() => {
        activeTick = undefined;
      });
      return activeTick;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await tick();
    if (!stopping) timer = setInterval(() => void tick(), intervalMs);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

function requiredEnv(name: "DATABASE_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("LIFECYCLE_INTERVAL_MS must be a positive integer");
  }
  return parsed;
}

void start().catch((error: unknown) => {
  workerLog("error", "worker.start.error", { error });
  process.exitCode = 1;
});

function workerLog(
  level: "error" | "info",
  event: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  writeStructuredLog({ event, fields, level, service: "worker" });
}
