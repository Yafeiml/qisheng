import type { components } from "@xhs-agentic/contracts";

type Material = components["schemas"]["MaterialResponseDto"];
type FailureGuide = Readonly<{
  title: string;
  reason: string;
  steps: readonly string[];
  action: "RETRY" | "UPDATE" | "ADMIN";
}>;

const fileFailures: Record<string, FailureGuide> = {
  EMPTY_EXTRACTED_TEXT: {
    title: "未读取到可用文字",
    reason: "资料中没有可提取的文字，扫描版 PDF 也可能出现这种情况。",
    steps: ["检查原文件是否有文字；扫描件请先识别为文字，或直接粘贴正文后重新提交。"],
    action: "UPDATE",
  },
  DOCUMENT_PARSE_FAILED: {
    title: "文档无法读取",
    reason: "文档解析失败，文件可能损坏、加密，或使用了不兼容的格式。",
    steps: ["确认文档能正常打开且未加密，重新导出为 PDF、DOCX 或 TXT，再更新这条资料。"],
    action: "UPDATE",
  },
  TEXT_ENCODING_UNSUPPORTED: {
    title: "文本编码无法识别",
    reason: "文本文件的编码无法正确读取。",
    steps: ["将文件另存为 UTF-8 编码的 TXT，或直接粘贴正文后重新提交。"],
    action: "UPDATE",
  },
  FILE_MAGIC_MISMATCH: {
    title: "文件格式与内容不一致",
    reason: "文件内容与上传时识别的格式不一致，修改扩展名不会转换文件格式。",
    steps: ["用原软件重新导出文件，再通过“检查并更新内容”替换此附件。"],
    action: "UPDATE",
  },
  PDF_PAGE_LIMIT: {
    title: "PDF 页数超过处理上限",
    reason: "单个 PDF 超过了 100 页的处理上限。",
    steps: ["按主题拆成每份不超过 100 页的文档，再分别提交。"],
    action: "UPDATE",
  },
  EXTRACTED_TEXT_LIMIT: {
    title: "资料文字量超过处理上限",
    reason: "提取后的文字超过了 25 万字的处理上限。",
    steps: ["精简重复内容，或按主题拆成多份资料后重新提交。"],
    action: "UPDATE",
  },
  IMAGE_FORMAT_UNSUPPORTED: {
    title: "图片格式暂不支持",
    reason: "这张图片无法按受支持的格式读取。",
    steps: ["将图片重新导出为 JPEG、PNG 或 WebP，再替换此附件。"],
    action: "UPDATE",
  },
  IMAGE_PARSE_FAILED: {
    title: "图片无法读取",
    reason: "图片解析失败，文件可能损坏或内容不完整。",
    steps: ["确认图片能正常打开，重新导出为 JPEG、PNG 或 WebP，再替换此附件。"],
    action: "UPDATE",
  },
  ARTIFACT_NOT_STORED: {
    title: "附件上传尚未完成",
    reason: "处理任务未找到已完成上传的附件。",
    steps: ["通过“检查并更新内容”重新添加附件，等待上传完成后再提交。"],
    action: "UPDATE",
  },
  ARTIFACT_NOT_FOUND: {
    title: "未找到原始附件",
    reason: "处理服务未能找到这条资料的原始文件。",
    steps: ["通过“检查并更新内容”重新上传附件；若多条资料出现此问题，请联系管理员检查存储。"],
    action: "UPDATE",
  },
};

const providerFailures: Record<string, (service: string) => FailureGuide> = {
  CREDENTIAL_UNAVAILABLE: (service) => ({
    title: `${service}凭据无法读取`,
    reason: "平台无法读取当前供应商的调用凭据。",
    steps: ["请联系平台管理员检查供应商凭据与平台加密配置，恢复后再重新处理。"],
    action: "ADMIN",
  }),
  CONFIGURATION_INVALID: (service) => ({
    title: `${service}配置不符合要求`,
    reason: "所选模型的调用配置未通过检查。",
    steps: ["请联系平台管理员检查模型调用地址、参数和适配配置，修复后再重新处理。"],
    action: "ADMIN",
  }),
  REQUEST_FAILED: (service) => ({
    title: `${service}调用未完成`,
    reason: "本次模型调用失败，当前没有可确认的更具体原因。",
    steps: ["可重新处理一次；持续失败时，请复制排查信息给平台管理员检查模型服务。"],
    action: "RETRY",
  }),
  MODEL_NOT_CONFIGURED: (service) => ({
    title: `${service}尚未配置`,
    reason: `平台尚未选择可用的${service === "检索服务" ? "Embedding 模型" : "资料理解模型"}。`,
    steps: ["请联系平台管理员在“平台模型 API 与路由”中选择对应模型，保存后再重新处理。"],
    action: "ADMIN",
  }),
  MODEL_UNAVAILABLE: (service) => ({
    title: `${service}当前不可用`,
    reason: "所选模型或供应商已停用，或当前没有可用的模型路由。",
    steps: ["请联系平台管理员检查对应模型和供应商是否启用，恢复后再重新处理。"],
    action: "ADMIN",
  }),
  AUTH_FAILED: (service) => ({
    title: `${service}认证失败`,
    reason: "模型供应商拒绝了本次认证，可能是 API 密钥失效或账号没有调用权限。",
    steps: ["请联系平台管理员检查供应商密钥及模型调用权限，修复后再重新处理。"],
    action: "ADMIN",
  }),
  QUOTA_EXCEEDED: (service) => ({
    title: `${service}额度不足`,
    reason: "模型供应商返回了额度不足，当前无法继续调用。",
    steps: ["请联系平台管理员检查供应商余额或调用额度，恢复后再重新处理。"],
    action: "ADMIN",
  }),
  RATE_LIMITED: (service) => ({
    title: `${service}请求较多`,
    reason: "模型供应商限制了本次请求频率。",
    steps: ["稍后重新处理；如果多次遇到此问题，请联系平台管理员调整调用容量。"],
    action: "RETRY",
  }),
  TIMEOUT: (service) => ({
    title: `${service}响应超时`,
    reason: "模型服务未在规定时间内返回结果。",
    steps: ["稍后重新处理；如果仍失败，请将排查信息交给平台管理员检查模型服务。"],
    action: "RETRY",
  }),
  NETWORK: (service) => ({
    title: `${service}连接失败`,
    reason: "处理服务未能连接到模型供应商。",
    steps: ["稍后重新处理；持续失败时，请联系平台管理员检查供应商连接。"],
    action: "RETRY",
  }),
  SERVICE_UNAVAILABLE: (service) => ({
    title: `${service}暂时不可用`,
    reason: "模型供应商暂时无法完成请求。",
    steps: ["稍后重新处理；持续失败时，请联系平台管理员检查或更换模型服务。"],
    action: "RETRY",
  }),
  MODEL_NOT_FOUND: (service) => ({
    title: `${service}模型无法调用`,
    reason: "供应商未找到所选模型，或当前账号没有访问该模型的权限。",
    steps: ["请联系平台管理员刷新供应商模型列表，确认模型名称与权限后重新处理。"],
    action: "ADMIN",
  }),
  INVALID_REQUEST: (service) => ({
    title: `${service}请求不被支持`,
    reason: "模型供应商未接受本次请求格式或参数。",
    steps: ["请联系平台管理员检查模型能力与调用适配，确认后再重新处理。"],
    action: "ADMIN",
  }),
};

const analysisOutputFailures = new Set([
  "MATERIAL_ANALYSIS_INVALID_RESPONSE",
  "MATERIAL_ANALYSIS_OUTPUT_TRUNCATED",
  "MATERIAL_ANALYSIS_EMPTY",
  "MATERIAL_ANALYSIS_INVALID_OUTPUT",
  "MATERIAL_ANALYSIS_INVALID_FIELD",
  "MATERIAL_ANALYSIS_INVALID_LIST",
  "MATERIAL_ANALYSIS_INVALID_ENTITY",
  "MATERIAL_ANALYSIS_UNGROUNDED_SUMMARY",
]);
const embeddingOutputFailures = new Set([
  "EMBEDDING_INVALID_RESPONSE",
  "EMBEDDING_DIMENSIONS_CHANGED",
  "EMBEDDING_VECTOR_COUNT_MISMATCH",
]);
const artifactIntegrityFailures = new Set([
  "ARTIFACT_METADATA_MISMATCH",
  "ARTIFACT_CHECKSUM_MISMATCH",
]);

export function materialFailureGuide(material: Material): FailureGuide {
  const code = material.ingestionErrorCode ?? "";
  const fileFailure = Object.hasOwn(fileFailures, code) ? fileFailures[code] : undefined;
  if (fileFailure) return fileFailure;
  for (const [prefix, service] of [
    ["MATERIAL_ANALYSIS_", "资料理解服务"],
    ["EMBEDDING_", "检索服务"],
  ] as const) {
    if (code.startsWith(prefix)) {
      const failure = providerFailures[code.slice(prefix.length)];
      if (failure) return failure(service);
    }
  }
  if (analysisOutputFailures.has(code))
    return {
      title: "资料理解结果未通过校验",
      reason:
        code === "MATERIAL_ANALYSIS_OUTPUT_TRUNCATED"
          ? "模型返回的分析结果不完整。"
          : "模型返回的分析结果为空、格式不符合要求，或无法核实其中的资料信息。",
      steps: ["可以重新处理一次；如果仍失败，请联系平台管理员检查资料理解模型的输出能力。"],
      action: "RETRY",
    };
  if (embeddingOutputFailures.has(code))
    return {
      title: "检索模型返回结果不符合要求",
      reason:
        code === "EMBEDDING_DIMENSIONS_CHANGED"
          ? "返回的向量维度与平台配置不一致。"
          : "返回的向量数量或格式不符合检索要求。",
      steps: ["请联系平台管理员检查 Embedding 模型及向量配置，修复后再重新处理。"],
      action: "ADMIN",
    };
  if (artifactIntegrityFailures.has(code))
    return {
      title: "附件完整性校验未通过",
      reason: "存储的附件与上传记录不一致，或附件未能完整读取。",
      steps: ["请重新导出并替换附件；如果仍失败，请复制排查信息联系平台管理员。"],
      action: "UPDATE",
    };
  if (
    [
      "LINK_URL_MISSING",
      "LINK_URL_PRIVATE",
      "LINK_URL_UNSAFE",
      "LINK_REDIRECT_LIMIT",
      "LINK_CONTENT_TYPE_UNSUPPORTED",
      "LINK_RESPONSE_TOO_LARGE",
    ].includes(code) ||
    (/^LINK_HTTP_4\d{2}$/u.test(code) && code !== "LINK_HTTP_429")
  )
    return {
      title: "网页内容无法读取",
      reason: "链接内容未能获取，可能需要登录、已失效或不符合公开访问要求。",
      steps: ["请改为粘贴正文或上传文档；公开网页可检查链接后更新内容。"],
      action: "UPDATE",
    };
  if (code.startsWith("STORAGE_"))
    return {
      title: "资料存储服务不可用",
      reason: "附件存储或企业存储容量未通过检查。",
      steps: ["请联系管理员检查存储连接及企业可用容量，恢复后再提交资料。"],
      action: "ADMIN",
    };
  if (code === "RUNTIME_POLICY_MISSING")
    return {
      title: "资料处理配置尚未就绪",
      reason: "平台缺少本次资料处理所需的运行配置。",
      steps: ["请联系平台管理员完善运行配置，恢复后再重新处理。"],
      action: "ADMIN",
    };
  return {
    title: "处理遇到未识别的问题",
    reason: "本次处理未能完成，目前没有可识别的具体原因。",
    steps: ["请复制排查信息联系平台管理员，确认本次任务的失败原因后再恢复处理。"],
    action: "ADMIN",
  };
}

export function materialAutomaticallyRetrying(material: Material): boolean {
  const job = material.ingestionJobs[0];
  return Boolean(
    material.ingestionStatus === "FAILED" &&
      job?.status === "FAILED" &&
      job.attemptCount < (job.maxAttempts ?? 5),
  );
}

export function materialCanManuallyRetry(material: Material): boolean {
  if (material.ingestionStatus === "FAILED") return true;
  if (material.ingestionStatus !== "QUARANTINED") return false;
  const code = material.ingestionErrorCode ?? "";
  return (
    /^(MATERIAL_ANALYSIS|EMBEDDING)_/u.test(code) ||
    /^LINK_HTTP_5\d{2}$/u.test(code) ||
    [
      "RUNTIME_POLICY_MISSING",
      "STORAGE_ACCESS_DENIED",
      "ARTIFACT_NOT_LOADED",
      "EMPTY_EMBEDDING_INPUT",
      "BUNDLE_MATERIAL_TYPE_UNSUPPORTED",
      "BUNDLE_ARTIFACT_COUNT_INVALID",
      "MATERIAL_CHUNKS_MISSING",
      "MATERIAL_INGESTION_UNEXPECTED",
      "LINK_HTTP_429",
      "LINK_FETCH_NETWORK",
      "LINK_DNS_EMPTY",
      "LINK_FETCH_TIMEOUT",
    ].includes(code)
  );
}

export function materialFailureDiagnostic(material: Material): string {
  // Do not share legacy raw ingestionErrorMessage: it can contain supplier response text.
  const rawCode = material.ingestionErrorCode ?? "";
  const code =
    /^(?:MATERIAL_|EMBEDDING_|ARTIFACT_|FILE_|IMAGE_|PDF_|EXTRACTED_|EMPTY_|LINK_|STORAGE_|DOCUMENT_|TEXT_|RUNTIME_)[A-Z0-9_]{1,80}$/u.test(
      rawCode,
    )
      ? rawCode
      : "UNCLASSIFIED";
  const job = material.ingestionJobs[0];
  const guide = materialFailureGuide(material);
  return [
    `资料编号：${material.id}`,
    `任务编号：${job?.id ?? "未记录"}`,
    `错误代码：${code}`,
    `处理建议：${guide.action === "UPDATE" ? guide.title : "请联系平台管理员处理"}`,
    `处理状态：${materialAutomaticallyRetrying(material) ? "正在自动重试" : "已停止处理"}`,
    `处理次数：${job ? `${job.attemptCount} / ${job.maxAttempts ?? 5}` : "未记录"}`,
    `最后处理时间：${job?.finishedAt ? new Date(job.finishedAt).toLocaleString("zh-CN") : "未记录"}`,
  ].join("\n");
}
