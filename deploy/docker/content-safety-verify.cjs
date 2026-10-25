// Run in the candidate API image; the settings module starts no business timers or server.
require("reflect-metadata");
const { NestFactory } = require("@nestjs/core");
const { CONTENT_SAFETY_POLICY_VERSION } = require("@xhs-agentic/content-safety");
const {
  PlatformSettingsModule,
} = require("/app/dist/platform-settings/platform-settings.module.js");
const {
  PlatformContentSafetyService,
} = require("/app/dist/platform-settings/platform-content-safety.service.js");

let stage = "context";
const diagnosticCodes = new Set([
  "CONTENT_SAFETY_NOT_CONFIGURED",
  "CONTENT_SAFETY_RECEIPT_MISSING",
  "CONTENT_SAFETY_PROBE_FAILED",
  "CONTENT_SAFETY_VISION_PROBE_FAILED",
  "CONTENT_SAFETY_CONFIGURATION_CHANGED",
  "CONTENT_SAFETY_DNS_FAILED",
  "CONTENT_SAFETY_TIMEOUT",
  "CONTENT_SAFETY_NETWORK",
  "CONTENT_SAFETY_INVALID_RESPONSE",
  "CONTENT_SAFETY_RESPONSE_TOO_LARGE",
  "CONTENT_SAFETY_INPUT_INVALID",
  "CONTENT_SAFETY_PROBE_ERROR",
  "CONTENT_SAFETY_TEST_FAILED",
  "CONTENT_SAFETY_TEST_AUDIT_FAILED",
]);
const safeCode = (value) =>
  typeof value === "string" &&
  (diagnosticCodes.has(value) || /^CONTENT_SAFETY_HTTP_[1-5]\d{2}$/u.test(value))
    ? value
    : "CONTENT_SAFETY_VERIFY_FAILED";
const safeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) ? value : null;

async function verify() {
  const app = await NestFactory.createApplicationContext(PlatformSettingsModule, { logger: false });
  let failed = false;
  let failure;
  let verified;
  try {
    const service = await app.resolve(PlatformContentSafetyService);
    stage = "configuration";
    const configuration = await service.current();
    if (!configuration.configured || configuration.mode === "DISABLED")
      throw Object.assign(new Error("Content safety must be configured before deployment"), {
        code: "CONTENT_SAFETY_NOT_CONFIGURED",
      });
    if (!configuration.verified) {
      console.log("新版内容安全策略尚未验证；即将测试图文审核，可能调用已配置的付费模型。");
      stage = "probe";
      await service.verifyForOperations("部署前验证候选 API 镜像的内容安全策略");
    }
    stage = "receipt";
    if (!(await service.current()).verified)
      throw Object.assign(
        new Error("Content-safety verification receipt is missing or configuration changed"),
        {
          code: "CONTENT_SAFETY_RECEIPT_MISSING",
        },
      );
    verified = {
      contentSafety: "VERIFIED",
      policyVersion: CONTENT_SAFETY_POLICY_VERSION,
      reused: configuration.verified,
    };
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await app.close();
  } catch (error) {
    if (!failed) {
      stage = "close";
      failed = true;
      failure = error;
    } else {
      console.error(
        JSON.stringify({
          contentSafety: "FAILED",
          stage: "close",
          code: "CONTENT_SAFETY_CONTEXT_CLOSE_FAILED",
        }),
      );
    }
  }
  if (failed) throw failure;
  console.log(JSON.stringify(verified));
}

verify().catch((error) => {
  let response;
  try {
    response = typeof error?.getResponse === "function" ? error.getResponse() : undefined;
  } catch {
    // Exception inspection must not mask the original failure.
  }
  const failure = response?.failure;
  console.error(
    JSON.stringify({
      contentSafety: "FAILED",
      policyVersion: CONTENT_SAFETY_POLICY_VERSION,
      stage,
      code: safeCode(response?.code ?? error?.code),
      auditId: safeId(response?.auditId),
      ...(failure
        ? {
            failure: {
              code: safeCode(failure.code),
              probeStage: ["neutral", "image-risk"].includes(failure.probeStage)
                ? failure.probeStage
                : null,
              decision: ["PASS", "REVIEW", "BLOCK"].includes(failure.decision)
                ? failure.decision
                : null,
              retryable: failure.retryable === true,
              httpStatus:
                Number.isInteger(failure.httpStatus) &&
                failure.httpStatus >= 100 &&
                failure.httpStatus <= 599
                  ? failure.httpStatus
                  : null,
              providerRequestId: safeId(failure.providerRequestId),
            },
          }
        : {}),
    }),
  );
  console.error("候选 API 内容安全验证失败，停止服务切换；请检查审核配置与测试审计。");
  process.exitCode = 1;
});
