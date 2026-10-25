import { ProviderInvocationError } from "@xhs-agentic/ai-gateway";

type ModelStage = "MATERIAL_ANALYSIS" | "EMBEDDING";

// Only application-owned codes and fixed descriptions may reach tenant-visible records.
// Provider messages, response bodies and identifiers can contain credentials or source text.
const descriptions: Readonly<Record<string, string>> = {
  MATERIAL_INGESTION_UNEXPECTED: "处理资料时发生未能识别的系统异常。",
  MATERIAL_ANALYSIS_MODEL_NOT_CONFIGURED: "平台尚未配置资料理解模型。",
  MATERIAL_ANALYSIS_MODEL_UNAVAILABLE: "当前资料理解模型或供应商凭据不可用，或模型不支持这类资料。",
  MATERIAL_ANALYSIS_CREDENTIAL_UNAVAILABLE: "系统无法读取资料理解模型的加密凭据。",
  MATERIAL_ANALYSIS_CONFIGURATION_INVALID: "资料理解模型的调用配置不符合要求。",
  MATERIAL_ANALYSIS_OUTPUT_TRUNCATED: "资料理解模型的回复被截断，未能获得完整的分析结果。",
  MATERIAL_ANALYSIS_EMPTY: "资料理解模型未返回分析结果。",
  MATERIAL_ANALYSIS_INVALID_OUTPUT: "资料理解模型未返回符合要求的分析格式。",
  MATERIAL_ANALYSIS_INVALID_FIELD: "资料理解模型返回的分析字段不符合要求。",
  MATERIAL_ANALYSIS_INVALID_LIST: "资料理解模型返回的关键词或信息列表不符合要求。",
  MATERIAL_ANALYSIS_INVALID_ENTITY: "资料理解模型返回的人物或项目识别结果不符合要求。",
  MATERIAL_ANALYSIS_UNGROUNDED_SUMMARY:
    "资料理解模型生成了原资料未提供的信息，系统已停止使用该分析结果。",
  EMBEDDING_MODEL_NOT_CONFIGURED: "平台尚未配置向量检索模型。",
  EMBEDDING_MODEL_UNAVAILABLE: "当前向量检索模型或供应商凭据不可用。",
  EMBEDDING_CREDENTIAL_UNAVAILABLE: "系统无法读取向量检索模型的加密凭据。",
  EMBEDDING_CONFIGURATION_INVALID: "向量检索模型的调用配置不符合要求。",
  EMBEDDING_DIMENSIONS_CHANGED: "向量检索模型在同一次处理中返回了不同的向量维度。",
  EMBEDDING_VECTOR_COUNT_MISMATCH: "向量检索模型返回的向量数量与资料片段数量不一致。",
  EMPTY_EMBEDDING_INPUT: "资料没有可用于建立检索索引的内容。",
  EMPTY_EXTRACTED_TEXT: "未能从资料中读取到可用文字；文件可能只有扫描图片或内容为空。",
  DOCUMENT_PARSE_FAILED: "无法解析文档，文件可能损坏、加密或使用了不支持的文档格式。",
  IMAGE_PARSE_FAILED: "无法读取图片，文件可能损坏或使用了不支持的图片格式。",
  TEXT_ENCODING_UNSUPPORTED: "文本文件编码无法识别，目前需要 UTF-8 编码。",
  FILE_MAGIC_MISMATCH: "文件实际格式与上传时声明的格式不一致。",
  IMAGE_FORMAT_UNSUPPORTED: "图片格式不受支持，目前支持 JPG、PNG 和 WebP。",
  PDF_PAGE_LIMIT: "PDF 超过单份 100 页的处理上限。",
  EXTRACTED_TEXT_LIMIT: "资料文字超过单份 25 万字的处理上限。",
  ARTIFACT_NOT_STORED: "原文件尚未完成存储，无法开始处理。",
  ARTIFACT_NOT_LOADED: "处理任务未能读取原文件。",
  ARTIFACT_METADATA_MISMATCH: "原文件的大小或格式与上传记录不一致。",
  ARTIFACT_CHECKSUM_MISMATCH: "原文件完整性校验未通过。",
  ARTIFACT_NOT_FOUND: "存储服务中未找到这份资料的原文件。",
  STORAGE_READ_FAILED: "暂时无法从存储服务读取原文件。",
  STORAGE_ACCESS_DENIED: "存储服务拒绝了对原文件的访问。",
  MATERIAL_SOURCE_NOT_FOUND: "处理任务对应的资料记录不存在。",
  MATERIAL_CHUNKS_MISSING: "资料缺少可用于重建检索索引的文字片段。",
  RUNTIME_POLICY_MISSING: "平台运行配置缺失，无法处理资料。",
  BUNDLE_MATERIAL_TYPE_UNSUPPORTED: "这类资料不支持批量附件处理。",
  BUNDLE_ARTIFACT_COUNT_INVALID: "附件数量不符合要求，每组应包含 1 至 20 个文件。",
  TENANT_STORAGE_LIMIT_EXCEEDED: "企业存储空间不足，无法继续保存处理结果。",
  STORAGE_RESERVATION_INVALID: "处理结果的存储容量申请无效。",
  STORAGE_RESERVATION_KEY_REUSED: "处理结果的存储容量记录发生冲突。",
  STORAGE_RESERVATION_RELEASED: "处理结果的存储容量申请已失效。",
  STORAGE_RESERVATION_NOT_FOUND: "处理结果的存储容量记录不存在。",
  STORAGE_RESERVATION_ALREADY_COMMITTED: "处理结果的存储容量记录状态不一致。",
  STORAGE_ACCOUNT_LOCK_FAILED: "暂时无法锁定企业存储容量记录。",
  STORAGE_TRANSACTION_RETRY_EXHAUSTED: "企业存储容量更新冲突，重试后仍未完成。",
  LINK_URL_MISSING: "资料缺少公开链接地址。",
  LINK_URL_PRIVATE: "链接指向内网地址，无法作为公开资料读取。",
  LINK_URL_UNSAFE: "链接不符合公开资料的安全访问要求。",
  LINK_REDIRECT_LIMIT: "链接跳转次数过多，无法读取页面。",
  LINK_DNS_EMPTY: "暂时无法解析链接的域名。",
  LINK_FETCH_TIMEOUT: "读取公开链接超时。",
  LINK_FETCH_NETWORK: "暂时无法连接公开链接。",
  LINK_CONTENT_TYPE_UNSUPPORTED: "公开链接没有返回可解析的网页或文本。",
  LINK_RESPONSE_TOO_LARGE: "公开链接返回内容为空或超过单次读取上限。",
};

const modelFailureDescriptions: Readonly<Record<string, string>> = {
  AUTH_FAILED: "认证失败或没有模型访问权限。",
  MODEL_NOT_ALLOWED: "未获得当前供应商密钥的调用权限。",
  QUOTA_EXCEEDED: "模型供应商账户余额或调用额度不足。",
  RATE_LIMITED: "调用过于频繁，供应商暂时限制了请求。",
  TIMEOUT: "请求超时，未能获得处理结果。",
  NETWORK: "连接失败，暂时无法访问供应商。",
  MODEL_NOT_FOUND: "模型或调用地址不存在。",
  INVALID_REQUEST: "拒绝了本次请求，模型能力或请求格式可能不兼容。",
  SERVICE_UNAVAILABLE: "供应商服务暂时不可用。",
  INVALID_RESPONSE: "返回的结果格式不符合要求。",
  REQUEST_FAILED: "拒绝了本次调用，未能确定具体原因。",
};

function safeDescription(code: string): string | undefined {
  if (Object.hasOwn(descriptions, code)) return descriptions[code];
  for (const stage of ["MATERIAL_ANALYSIS", "EMBEDDING"] as const) {
    if (!code.startsWith(`${stage}_`)) continue;
    const reason = code.slice(stage.length + 1);
    const detail = Object.hasOwn(modelFailureDescriptions, reason)
      ? modelFailureDescriptions[reason]
      : undefined;
    if (detail) return `${stage === "EMBEDDING" ? "向量检索模型" : "资料理解模型"}${detail}`;
  }
  const linkStatus = /^LINK_HTTP_([45]\d{2})$/u.exec(code)?.[1];
  if (linkStatus) return `公开链接返回 HTTP ${linkStatus}，未能读取页面内容。`;
  return undefined;
}

export class MaterialIngestionError extends Error {
  readonly code: string;

  constructor(
    code: string,
    readonly retryable: boolean,
  ) {
    const description = safeDescription(code);
    super(description ?? descriptions.MATERIAL_INGESTION_UNEXPECTED);
    this.code = description ? code : "MATERIAL_INGESTION_UNEXPECTED";
    this.name = "MaterialIngestionError";
  }
}

export function classifyIngestionError(error: unknown): MaterialIngestionError {
  if (error instanceof MaterialIngestionError) return error;
  if (error instanceof ProviderInvocationError) {
    return classifyModelIngestionError(
      error,
      error.details?.requestPath === "/embeddings" ? "EMBEDDING" : "MATERIAL_ANALYSIS",
    );
  }
  const code = error instanceof Error ? error.message : "";
  // Preserve retry behavior for existing application errors, but allow only known codes.
  return new MaterialIngestionError(code, true);
}

export function classifyModelIngestionError(
  error: unknown,
  stage: ModelStage,
): MaterialIngestionError {
  if (!(error instanceof ProviderInvocationError)) return classifyIngestionError(error);
  const status = error.details?.httpStatus;
  const code = error.code.toLowerCase();
  let reason: string;
  // NineAPI distinguishes a valid key lacking the selected model grant from an
  // invalid key. Its authoritative business code takes precedence over HTTP 403.
  if (code === "gw_model_not_allowed") reason = "MODEL_NOT_ALLOWED";
  else if (
    new Set([
      "insufficient_quota",
      "quota_exceeded",
      "gw_quota_exceeded",
      "gw_quota_member_budget",
      "account_quota_exceeded",
      "billing_hard_limit_reached",
      "insufficient_balance",
      "balance_not_enough",
      "arrearage",
    ]).has(code) ||
    status === 402
  )
    reason = "QUOTA_EXCEEDED";
  else if (code === "gw_quota_rate_limit") reason = "RATE_LIMITED";
  else if (
    status === 401 ||
    status === 403 ||
    new Set([
      "invalid_api_key",
      "gw_auth_invalid_key",
      "gw_auth_key_disabled",
      "authentication_failed",
      "unauthorized",
      "permission_denied",
    ]).has(code)
  )
    reason = "AUTH_FAILED";
  else if (status === 429 || new Set(["rate_limit_exceeded", "too_many_requests"]).has(code))
    reason = "RATE_LIMITED";
  else if (code === "provider_timeout" || status === 408 || status === 504) reason = "TIMEOUT";
  else if (code === "provider_network") reason = "NETWORK";
  else if (status === 404 || code === "model_not_found") reason = "MODEL_NOT_FOUND";
  else if (status === 400 || status === 413 || status === 422) reason = "INVALID_REQUEST";
  else if (status !== undefined && status >= 500) reason = "SERVICE_UNAVAILABLE";
  else if (
    new Set([
      "invalid_provider_response",
      "malformed_provider_response",
      "empty_text_output",
      "invalid_text_output",
      "invalid_embedding_indexes",
      "invalid_embedding_profile",
      "invalid_embedding_output",
      "invalid_embedding_dimensions",
    ]).has(code)
  )
    reason = "INVALID_RESPONSE";
  else reason = "REQUEST_FAILED";
  // Some suppliers label exhausted account quotas as HTTP 429. Retrying cannot repair
  // credentials/permissions or account balance; reserve automatic retry for transient errors.
  const retryable =
    reason === "AUTH_FAILED" || reason === "QUOTA_EXCEEDED" || reason === "MODEL_NOT_ALLOWED"
      ? false
      : error.retryable;
  return new MaterialIngestionError(`${stage}_${reason}`, retryable);
}

export function classifyArtifactReadError(error: unknown): MaterialIngestionError {
  if (error instanceof MaterialIngestionError) return error;
  const value = typeof error === "object" && error !== null ? error : {};
  const name = "name" in value ? value.name : undefined;
  const metadata = "$metadata" in value ? value.$metadata : undefined;
  const status =
    typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata
      ? metadata.httpStatusCode
      : undefined;
  if (name === "NoSuchKey" || name === "NotFound" || status === 404)
    return new MaterialIngestionError("ARTIFACT_NOT_FOUND", false);
  if (name === "AccessDenied" || status === 401 || status === 403)
    return new MaterialIngestionError("STORAGE_ACCESS_DENIED", false);
  return new MaterialIngestionError("STORAGE_READ_FAILED", true);
}
