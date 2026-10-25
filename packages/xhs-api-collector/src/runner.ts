import { lstatSync, readFileSync } from "node:fs";
import { SignedReadbackApi } from "./job-api";
import {
  fetchNoteDetail,
  normalizeNoteDetailAuthorization,
  normalizeNoteDetailEndpoint,
} from "./note-detail";
import type { PanelState } from "./panel-state";

export async function runOnce(
  api: SignedReadbackApi,
  provider: { endpoint: string; token: string },
  fetchNote: typeof fetchNoteDetail = fetchNoteDetail,
): Promise<"IDLE" | "PAUSED" | "COMMITTED"> {
  if (!provider.endpoint.trim() || !provider.token.trim()) return "IDLE";
  const endpoint = normalizeNoteDetailEndpoint(provider.endpoint);
  normalizeNoteDetailAuthorization(provider.token);
  const { paused, job } = await api.claim();
  if (paused) return "PAUSED";
  if (!job) return "IDLE";
  // The vendor is called once per lease; if the commit is lost the API marks
  // its expiry ambiguous instead of silently billing another lookup.
  const result = await fetchNote({ endpoint, token: provider.token, noteId: job.noteId });
  const observedAt = new Date();
  await api.result(job, result, observedAt);
  return "COMMITTED";
}

export async function runManagedOnce(
  api: SignedReadbackApi,
  fetchNote: typeof fetchNoteDetail = fetchNoteDetail,
): Promise<"IDLE" | "PAUSED" | "COMMITTED"> {
  const { paused, job, provider } = await api.managedClaim();
  if (paused) return "PAUSED";
  if (!job || !provider) return "IDLE";
  const result = await fetchNote({ ...provider, noteId: job.noteId });
  await api.result(job, result, new Date());
  return "COMMITTED";
}

export function readManagedNodeKey(
  file = process.env.PUBLICATION_READBACK_NODE_KEY_FILE ||
    "/run/qisheng-readback/readback-node-key",
): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("MANAGED_NODE_KEY_FILE_INVALID");
  const key = readFileSync(file, "utf8").trim();
  if (key.length < 32 || key.length > 4096 || /\s/u.test(key))
    throw new Error("MANAGED_NODE_KEY_INVALID");
  return key;
}

export async function runManagedService() {
  const nodeId = process.env.PUBLICATION_READBACK_NODE_ID || "selfhost-readback";
  if (nodeId !== "selfhost-readback") throw new Error("MANAGED_NODE_ID_INVALID");
  const api = new SignedReadbackApi(
    required("PUBLICATION_READBACK_API_BASE_URL"),
    nodeId,
    readManagedNodeKey(),
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      try {
        const result = await runManagedOnce(api);
        if (result === "COMMITTED") process.stdout.write("READBACK_JOB_COMMITTED\n");
        if (!stopping) await delay(result === "COMMITTED" ? 10_000 : 30_000);
      } catch {
        process.stderr.write("READBACK_CYCLE_FAILED\n");
        if (!stopping) await delay(30_000);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runService(state: PanelState) {
  const origin = required("PUBLICATION_READBACK_API_BASE_URL");
  const nodeId = required("PUBLICATION_READBACK_NODE_ID");
  const key = required("PUBLICATION_READBACK_NODE_KEY");
  const api = new SignedReadbackApi(origin, nodeId, key);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      if (!state.workerEnabled) {
        await delay(10_000);
        continue;
      }
      const token = state.token();
      const endpoint = state.endpoint;
      if (!token || !endpoint) {
        await delay(10_000);
        continue;
      }
      const result = await runOnce(api, { endpoint, token });
      // Operational output contains no note IDs, URLs, response bodies or credentials.
      if (result === "COMMITTED") process.stdout.write("READBACK_JOB_COMMITTED\n");
      await delay(result === "COMMITTED" ? 10_000 : 30_000);
    } catch {
      process.stderr.write("READBACK_CYCLE_FAILED\n");
      await delay(30_000);
    }
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

async function delay(ms: number) {
  await new Promise((done) => setTimeout(done, ms));
}
