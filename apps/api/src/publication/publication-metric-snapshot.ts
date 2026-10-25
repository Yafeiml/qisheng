import { ConflictException } from "@nestjs/common";
import {
  INGEST_METRIC_NAMES,
  type IngestPublicationMetricsDto,
  SAFE_METRIC_DISPLAY,
} from "./publication.dto";
import { metricValueForIngress } from "./publication-metrics-security";

type MetricName = (typeof INGEST_METRIC_NAMES)[number];
type Precision = "EXACT" | "APPROXIMATE" | "UNAVAILABLE";

export function normalizeMetricSnapshot(input: IngestPublicationMetricsDto) {
  const values = Object.fromEntries(
    INGEST_METRIC_NAMES.map((name) => [name, metricValueForIngress(input, name)]),
  ) as Record<MetricName, number | null>;
  const raw = input.rawData;
  if (raw) {
    rejectUnknownKeys(raw, ["metricPrecision", "metricDisplay"]);
    if (raw.metricPrecision) rejectUnknownKeys(raw.metricPrecision, INGEST_METRIC_NAMES);
    if (raw.metricDisplay) rejectUnknownKeys(raw.metricDisplay, INGEST_METRIC_NAMES);
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 1_024) {
      throw new ConflictException("指标证据超出大小限制");
    }
  }

  let hasObservation = false;
  for (const name of INGEST_METRIC_NAMES) {
    const value = values[name];
    const precision: Precision | undefined = raw?.metricPrecision?.[name];
    const display = raw?.metricDisplay?.[name];
    if (value !== null) {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 2_147_483_647 ||
        (precision && precision !== "EXACT")
      ) {
        throw new ConflictException(`指标 ${name} 的数值和精度不一致`);
      }
      hasObservation = true;
    } else if (precision === "EXACT") {
      throw new ConflictException(`指标 ${name} 缺少精确数值`);
    }
    if (display !== undefined) {
      if (
        typeof display !== "string" ||
        display.length > 32 ||
        !SAFE_METRIC_DISPLAY.test(display) ||
        precision !== "APPROXIMATE" ||
        value !== null
      ) {
        throw new ConflictException(`指标 ${name} 的近似展示值无效`);
      }
      hasObservation = true;
    } else if (precision === "APPROXIMATE") {
      throw new ConflictException(`指标 ${name} 的近似展示值缺失`);
    }
    if (precision && !["EXACT", "APPROXIMATE", "UNAVAILABLE"].includes(precision)) {
      throw new ConflictException(`指标 ${name} 的精度无效`);
    }
  }
  if (!hasObservation) {
    throw new ConflictException("至少提供一项实际读取到的公开指标");
  }
  return { rawData: raw ?? null, values };
}

function rejectUnknownKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ConflictException("指标证据包含未受支持的字段");
  }
}
