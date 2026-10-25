import type { Collector } from "./collector";

/** Windows Task Scheduler fallback: exactly one due job; every call has its own guard/lease. */
export async function runOneCycle(collector: Collector): Promise<object> {
  const claim = (await collector.claim()) as { status: string; jobId?: string };
  if (claim.status !== "CLAIMED" || !claim.jobId) return claim;
  const read = (await collector.read(claim.jobId)) as {
    status: string;
    evidenceHandle?: string;
  };
  if (!read.evidenceHandle) throw new Error("COLLECTOR_EVIDENCE_MISSING");
  await collector.commit(read.evidenceHandle);
  return { status: "COMMITTED", jobId: claim.jobId, observationStatus: read.status };
}
