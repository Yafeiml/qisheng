#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const directoryArgument = process.argv[2];
const port = Number(process.argv[3] ?? 18765);
if (!directoryArgument)
  throw new Error("Usage: node serve-review.mjs <benchmark-directory> [port]");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("Review server port must be between 1024 and 65535");
}

const root = resolve(directoryArgument);
const [report, results] = await Promise.all([
  readJson(resolve(root, "report.json")),
  readJson(resolve(root, "results.json")),
]);
const benchmarkId = requiredString(report.benchmarkId, "report benchmarkId");
const reviewKind = Array.isArray(results.items)
  ? "AI_PROVIDER"
  : Array.isArray(results.samples)
    ? "PUBLICATION_P014"
    : null;
if (!reviewKind) throw new Error("Benchmark results do not contain supported review entries");
const expectedIds = new Set(
  reviewKind === "AI_PROVIDER"
    ? results.items.map((item) =>
        requiredString(record(item).employeeMembershipId, "membership ID"),
      )
    : results.samples.map((item) => requiredString(record(item).sampleId, "sample ID")),
);
if (expectedIds.size < 1) throw new Error("Benchmark results contain no review entries");

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Review server error"}\n`);
    sendJson(response, 500, { error: "INTERNAL_ERROR" });
  });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Review service: http://localhost:${port}/review.html\n`);
  process.stdout.write(`Serving only: ${root}\n`);
});

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/api/manual-review") {
    const review = await readRequestJson(request, 2 * 1024 * 1024);
    validateReview(review);
    const destination = resolve(root, "manual-review.json");
    const temporary = resolve(root, `.manual-review-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    sendJson(response, 200, { benchmarkId, saved: true });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  const pathname = url.pathname === "/" ? "/review.html" : decodeURIComponent(url.pathname);
  const target = resolve(root, `.${pathname}`);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    sendJson(response, 403, { error: "FORBIDDEN" });
    return;
  }
  let metadata;
  try {
    metadata = await stat(target);
  } catch {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }
  if (!metadata.isFile()) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": metadata.size,
    "Content-Type": mimeType(target),
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(target).pipe(response);
}

function validateReview(value) {
  const review = record(value);
  if (review.benchmarkId !== benchmarkId) throw new Error("Review benchmarkId does not match");
  if (review.synthetic !== false) throw new Error("Review must be non-synthetic");
  if (typeof review.reviewer !== "string" || review.reviewer.trim().length < 2) {
    throw new Error("Review signer is required");
  }
  if (!Array.isArray(review.entries) || review.entries.length !== expectedIds.size) {
    throw new Error("Review must contain every benchmark entry");
  }
  if (reviewKind === "PUBLICATION_P014") {
    if (review.schemaVersion !== 1) throw new Error("P-014 review schemaVersion must be 1");
    if (review.responsibilityAccepted !== true) {
      throw new Error("P-014 review responsibility confirmation is required");
    }
    if (
      typeof review.approvedPolicyVersion !== "string" ||
      review.approvedPolicyVersion.trim().length === 0
    ) {
      throw new Error("P-014 review approvedPolicyVersion is required");
    }
    if (
      typeof review.reviewedAt !== "string" ||
      Number.isNaN(new Date(review.reviewedAt).getTime())
    ) {
      throw new Error("P-014 review reviewedAt is invalid");
    }
  }
  const receivedIds = new Set();
  for (const rawEntry of review.entries) {
    const entry = record(rawEntry);
    const entryId =
      reviewKind === "AI_PROVIDER"
        ? requiredString(entry.employeeMembershipId, "review membership ID")
        : requiredString(entry.sampleId, "review sample ID");
    if (!expectedIds.has(entryId) || receivedIds.has(entryId)) {
      throw new Error("Review contains an unknown or duplicate entry ID");
    }
    receivedIds.add(entryId);
    if (entry.decision !== "PASS" && entry.decision !== "FAIL") {
      throw new Error("Every review entry must be PASS or FAIL");
    }
  }
}

async function readRequestJson(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("Review request exceeds size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Review request is not valid JSON");
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}
