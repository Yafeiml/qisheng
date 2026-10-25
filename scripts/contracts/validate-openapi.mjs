#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const openApiPath = resolve(process.argv[2] ?? "packages/contracts/openapi/openapi.json");
const generatedPath = resolve(process.argv[3] ?? "packages/contracts/src/generated/openapi.ts");
const [openApiSource, generatedSource] = await Promise.all([
  readFile(openApiPath, "utf8"),
  readFile(generatedPath, "utf8"),
]);
const document = JSON.parse(openApiSource);
const failures = [];
const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
let operationCount = 0;

for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem ?? {})) {
    if (!HTTP_METHODS.has(method) || !operation || typeof operation !== "object") continue;
    operationCount += 1;
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!/^2\d\d$/u.test(status) || status === "204") continue;
      const location = `${method.toUpperCase()} ${path} ${status}`;
      const resolvedResponse = resolveReference(document, response);
      const mediaType =
        resolvedResponse?.content?.["application/json"] ??
        resolvedResponse?.content?.["application/*+json"];
      if (!mediaType?.schema) {
        const documentedNonJson = Object.entries(resolvedResponse?.content ?? {}).find(
          ([contentType, content]) =>
            !contentType.includes("json") &&
            content &&
            typeof content === "object" &&
            content.schema,
        );
        if (documentedNonJson) continue;
        failures.push(`${location}: non-204 success response has no documented schema`);
        continue;
      }
      const schema = resolveReference(document, mediaType.schema);
      if (isEmptyObjectSchema(schema)) {
        failures.push(`${location}: success response uses an empty object schema`);
      }
    }
  }
}

if (operationCount === 0) failures.push("OpenAPI document contains no operations");
if (openApiSource.includes("#/components/schemas/Object")) {
  failures.push("OpenAPI document references the ambiguous Object schema");
}

for (const [index, line] of generatedSource.split("\n").entries()) {
  if (!line.includes("Record<string, never>")) continue;
  if (/export type (webhooks|\$defs) = Record<string, never>;/u.test(line.trim())) continue;
  failures.push(
    `${generatedPath}:${index + 1}: business contract generated as Record<string, never>`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`OpenAPI quality gate failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `OpenAPI quality gate passed (${operationCount} operations; explicit success schemas).\n`,
  );
}

function resolveReference(root, value) {
  if (!value || typeof value !== "object" || !("$ref" in value)) return value;
  const reference = value.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return value;
  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => current?.[segment], root);
}

function isEmptyObjectSchema(schema) {
  if (!schema || typeof schema !== "object" || schema.type !== "object") return false;
  return !(
    schema.properties ||
    schema.additionalProperties ||
    schema.allOf ||
    schema.anyOf ||
    schema.oneOf
  );
}
