import { join } from "node:path";
import { SignedJobSource } from "./api";
import { BrowserNoteReader } from "./browser";
import { Collector } from "./collector";
import { startMcp } from "./mcp";
import { runOneCycle } from "./once";
import { LocalGuard } from "./store";

async function main(): Promise<void> {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--once")) {
    throw new Error("COLLECTOR_UNSUPPORTED_ARGUMENT");
  }
  const root =
    process.env.XHS_COLLECTOR_DATA_DIR ??
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "XHSAgentic", "collector")
      : undefined);
  const origin = process.env.XHS_COLLECTOR_API_ORIGIN;
  const id = process.env.XHS_COLLECTOR_ID;
  const secret = process.env.XHS_COLLECTOR_SECRET;
  if (!root || !origin || !id || !secret) throw new Error("COLLECTOR_CONFIGURATION_MISSING");
  const source = new SignedJobSource(origin, id, secret);
  const guard = new LocalGuard(root);
  await guard.start();
  const collector = new Collector(
    source,
    guard,
    new BrowserNoteReader(join(root, "browser-profile"), async (job, ordinal) => {
      const local = await guard.status();
      if (local.paused) throw new Error("COLLECTOR_PAUSED");
      const remote = await source.status();
      if (remote.paused) throw new Error("SERVER_PAUSED");
      const heartbeat = await source.heartbeat(job);
      if (heartbeat.paused || Date.parse(heartbeat.leaseExpiresAt) - Date.now() < 95_000) {
        throw new Error("LEASE_TOO_SHORT");
      }
      if (ordinal > 0) await guard.reserve(job, new Date(), ordinal);
    }),
  );
  if (process.argv[2] === "--once") {
    try {
      const result = await runOneCycle(collector);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await collector.close();
    }
    return;
  }
  startMcp(collector);
  const shutdown = () => {
    void collector.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(() => {
  // WorkBuddy receives a generic failure, never the configuration value or access token.
  process.stderr.write("Collector failed to start; inspect local setup and stale lock.\n");
  process.exitCode = 1;
});
