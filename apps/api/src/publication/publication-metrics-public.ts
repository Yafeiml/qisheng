import type { Prisma } from "@xhs-agentic/database";
import { INGEST_METRIC_NAMES, SAFE_METRIC_DISPLAY } from "./publication.dto";

type MetricName = (typeof INGEST_METRIC_NAMES)[number];
type MetricRecord = Record<MetricName, number | null> & { rawData: Prisma.JsonValue | null };
type PublicMetricMetadata = {
  metricDisplay: Record<string, string>;
  metricPrecision: Record<string, string>;
};

// Historic metric snapshots may contain arbitrary provider data. Public APIs
// return only the precision and short, numeric display values needed by the UI.
export function publicMetricSnapshot<T extends MetricRecord>(
  snapshot: T,
): Omit<T, "rawData"> & { rawData: PublicMetricMetadata | null } {
  const raw = record(snapshot.rawData);
  const inputPrecision = record(raw?.metricPrecision);
  const inputDisplay = record(raw?.metricDisplay);
  const metricPrecision: Record<string, string> = {};
  const metricDisplay: Record<string, string> = {};
  for (const name of INGEST_METRIC_NAMES) {
    const precision = inputPrecision?.[name];
    const display = inputDisplay?.[name];
    if (precision === "EXACT" && snapshot[name] !== null) {
      metricPrecision[name] = precision;
    } else if (precision === "UNAVAILABLE" && snapshot[name] === null) {
      metricPrecision[name] = precision;
    } else if (
      precision === "APPROXIMATE" &&
      snapshot[name] === null &&
      typeof display === "string" &&
      display.length <= 32 &&
      SAFE_METRIC_DISPLAY.test(display)
    ) {
      metricPrecision[name] = precision;
      metricDisplay[name] = display.trim();
    }
  }
  const rawData: PublicMetricMetadata | null =
    Object.keys(metricPrecision).length > 0 ? { metricDisplay, metricPrecision } : null;
  return { ...snapshot, rawData };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
