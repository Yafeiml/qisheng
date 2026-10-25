import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./docker/content-safety-verify.cjs", import.meta.url), "utf8");

async function runVerifier({
  configured = true,
  mode = "MODEL",
  initiallyVerified = false,
  finallyVerified = true,
  verificationError,
  configurationError,
  contextError,
  closeError,
} = {}) {
  const calls = [];
  const output = [];
  const errors = [];
  const process = {};
  class PlatformSettingsModule {}
  class PlatformContentSafetyService {}
  let reads = 0;
  const service = {
    async current() {
      calls.push("current");
      if (configurationError) throw configurationError;
      return { configured, mode, verified: reads++ === 0 ? initiallyVerified : finallyVerified };
    },
    async verifyForOperations(reason) {
      calls.push("verify");
      assert.equal(reason, "部署前验证候选 API 镜像的内容安全策略");
      if (verificationError) throw verificationError;
    },
  };
  const modules = {
    "reflect-metadata": {},
    "@xhs-agentic/content-safety": { CONTENT_SAFETY_POLICY_VERSION: "test-policy-v2" },
    "/app/dist/platform-settings/platform-settings.module.js": { PlatformSettingsModule },
    "/app/dist/platform-settings/platform-content-safety.service.js": {
      PlatformContentSafetyService,
    },
    "@nestjs/core": {
      NestFactory: {
        async createApplicationContext(module, options) {
          assert.equal(module, PlatformSettingsModule);
          assert.equal(options.logger, false);
          calls.push("context");
          if (contextError) throw contextError;
          return {
            async resolve(type) {
              assert.equal(type, PlatformContentSafetyService);
              return service;
            },
            async close() {
              calls.push("close");
              if (closeError) throw closeError;
            },
          };
        },
      },
    },
  };
  await runInNewContext(source, {
    process,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`);
      return modules[name];
    },
    console: { log: (value) => output.push(value), error: (value) => errors.push(value) },
  });
  return { calls, output, errors, exitCode: process.exitCode ?? 0 };
}

test("candidate API reuses a matching verification without model calls", async () => {
  const result = await runVerifier({ initiallyVerified: true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.calls, ["context", "current", "current", "close"]);
  assert.deepEqual(JSON.parse(result.output[0]), {
    contentSafety: "VERIFIED",
    policyVersion: "test-policy-v2",
    reused: true,
  });
  assert.deepEqual(result.errors, []);
});

test("candidate API invokes the existing SYSTEM verifier only when needed", async () => {
  const result = await runVerifier();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.calls, ["context", "current", "verify", "current", "close"]);
  assert.match(result.output[0], /可能调用已配置的付费模型/u);
  assert.equal(JSON.parse(result.output[1]).reused, false);
});

test("failed probes stop deployment, close the context and suppress provider details", async () => {
  const result = await runVerifier({ verificationError: new Error("private-provider-response") });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.calls, ["context", "current", "verify", "close"]);
  assert.match(result.errors.join(""), /停止服务切换/u);
  assert.doesNotMatch(result.errors.join(""), /private-provider-response/u);
  assert.equal(JSON.parse(result.errors[0]).code, "CONTENT_SAFETY_VERIFY_FAILED");
});

test("failed probes print only safe diagnosis and audit references", async () => {
  const result = await runVerifier({
    verificationError: {
      message: "private-provider-response",
      cause: { apiKey: "private-key" },
      stack: "private-stack",
      getResponse: () => ({
        code: "CONTENT_SAFETY_HTTP_503",
        auditId: "audit-123",
        message: "private-provider-response",
        failure: {
          code: "CONTENT_SAFETY_HTTP_503",
          probeStage: "image-risk",
          retryable: true,
          httpStatus: 503,
          providerRequestId: "req-123",
          provider: "private-key",
          model: "private-model",
        },
      }),
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.errors[0]), {
    contentSafety: "FAILED",
    policyVersion: "test-policy-v2",
    stage: "probe",
    code: "CONTENT_SAFETY_HTTP_503",
    auditId: "audit-123",
    failure: {
      code: "CONTENT_SAFETY_HTTP_503",
      probeStage: "image-risk",
      decision: null,
      retryable: true,
      httpStatus: 503,
      providerRequestId: "req-123",
    },
  });
  assert.doesNotMatch(result.errors.join(""), /private-/u);
  assert.equal(result.calls.at(-1), "close");
});

test("untrusted diagnostic fields cannot escape the verifier whitelist", async () => {
  const result = await runVerifier({
    verificationError: {
      getResponse: () => ({
        code: "private-key",
        auditId: "https://private-key.example",
        failure: {
          code: "CONTENT_SAFETY_PRIVATE_KEY",
          probeStage: "private-stage",
          decision: "private-decision",
          retryable: "private-value",
          httpStatus: "private-status",
          providerRequestId: "Authorization: private-key",
        },
      }),
    },
  });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.errors.join(""), /private/iu);
  assert.deepEqual(JSON.parse(result.errors[0]).failure, {
    code: "CONTENT_SAFETY_VERIFY_FAILED",
    probeStage: null,
    decision: null,
    retryable: false,
    httpStatus: null,
    providerRequestId: null,
  });
});

test("context and configuration errors stop without attempting a probe", async () => {
  for (const [option, stage] of [
    ["contextError", "context"],
    ["configurationError", "configuration"],
  ]) {
    const result = await runVerifier({ [option]: new Error("private-error") });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.errors[0]).stage, stage);
    assert.ok(!result.calls.includes("verify"));
    assert.equal(result.calls.includes("close"), option === "configurationError");
    assert.doesNotMatch(result.errors.join(""), /private-error/u);
  }
});

test("closing the context cannot hide a failed probe or produce a success line", async () => {
  const failedProbe = await runVerifier({
    verificationError: { getResponse: () => ({ code: "CONTENT_SAFETY_TIMEOUT" }) },
    closeError: new Error("private-close-error"),
  });
  assert.equal(failedProbe.exitCode, 1);
  assert.deepEqual(
    failedProbe.errors.slice(0, 2).map((line) => JSON.parse(line).code),
    ["CONTENT_SAFETY_CONTEXT_CLOSE_FAILED", "CONTENT_SAFETY_TIMEOUT"],
  );
  const failedClose = await runVerifier({
    initiallyVerified: true,
    closeError: new Error("private-close-error"),
  });
  assert.equal(failedClose.exitCode, 1);
  assert.equal(JSON.parse(failedClose.errors[0]).stage, "close");
  assert.deepEqual(failedClose.output, []);
  assert.doesNotMatch(failedProbe.errors.join(""), /private-close-error/u);
});

test("disabled, missing or changed verification cannot pass the deployment gate", async () => {
  for (const options of [
    { configured: false },
    { mode: "DISABLED" },
    { finallyVerified: false },
    { initiallyVerified: true, finallyVerified: false },
  ]) {
    const result = await runVerifier(options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.calls.at(-1), "close");
    assert.ok(result.output.every((line) => !line.includes('"VERIFIED"')));
    if (options.configured === false || options.mode === "DISABLED")
      assert.ok(!result.calls.includes("verify"));
  }
});
