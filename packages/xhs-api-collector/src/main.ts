import { startPanel } from "./panel";
import { PanelState } from "./panel-state";
import { runManagedService, runService } from "./runner";

async function start() {
  if (process.env.READBACK_MANAGED === "true") return runManagedService();
  const { state, close } = await startPanel(
    new PanelState(process.env.READBACK_STATE_DIR ?? "/var/lib/qisheng-readback"),
  );
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  try {
    await runService(state);
  } finally {
    await close();
  }
}

void start().catch(() => {
  process.stderr.write("READBACK_SERVICE_FAILED\n");
  process.exit(1);
});
