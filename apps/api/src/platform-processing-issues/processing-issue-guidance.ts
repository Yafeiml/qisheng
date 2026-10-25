import type { ProcessingIssueDto } from "./platform-processing-issues.dto";

const fileDescriptions: Readonly<Record<string, string>> = {
  EMPTY_EXTRACTED_TEXT: "未读取到可用文字，资料可能为空或只有扫描图片。",
  DOCUMENT_PARSE_FAILED: "文档无法解析，可能损坏、加密或格式不支持。",
  IMAGE_PARSE_FAILED: "图片无法读取，可能损坏或格式不支持。",
  TEXT_ENCODING_UNSUPPORTED: "文本文件不是可识别的 UTF-8 编码。",
  FILE_MAGIC_MISMATCH: "文件实际格式与上传声明的格式不一致。",
  IMAGE_FORMAT_UNSUPPORTED: "图片格式不受支持。",
  PDF_PAGE_LIMIT: "PDF 超过单份 100 页的处理上限。",
  EXTRACTED_TEXT_LIMIT: "文字超过单份 25 万字的处理上限。",
  ARTIFACT_NOT_STORED: "原文件尚未完成存储。",
  ARTIFACT_METADATA_MISMATCH: "原文件大小或格式与上传记录不一致。",
  ARTIFACT_CHECKSUM_MISMATCH: "原文件完整性校验失败。",
  ARTIFACT_NOT_FOUND: "存储服务中没有找到原文件。",
  LINK_URL_MISSING: "资料缺少公开链接。",
  LINK_URL_PRIVATE: "链接指向不能公开访问的内网地址。",
  LINK_URL_UNSAFE: "链接不符合安全访问要求。",
  LINK_REDIRECT_LIMIT: "链接跳转次数超过限制。",
  LINK_CONTENT_TYPE_UNSUPPORTED: "链接未返回可读取的网页或文本。",
  LINK_RESPONSE_TOO_LARGE: "链接内容为空或超过读取上限。",
};
export const USER_FIXABLE_PROCESSING_CODES = Object.keys(fileDescriptions);
const modelDescriptions: Readonly<Record<string, string>> = {
  MODEL_NOT_CONFIGURED: "尚未配置。",
  MODEL_UNAVAILABLE: "或供应商凭据不可用，或不支持当前资料。",
  CREDENTIAL_UNAVAILABLE: "的加密凭据无法读取。",
  CONFIGURATION_INVALID: "调用配置不符合要求。",
  AUTH_FAILED: "认证失败或缺少访问权限。",
  MODEL_NOT_ALLOWED: "未获得当前供应商密钥的调用权限。",
  QUOTA_EXCEEDED: "供应商账户余额或调用额度不足。",
  RATE_LIMITED: "供应商暂时限制了调用频率。",
  TIMEOUT: "请求超时。",
  NETWORK: "供应商连接失败。",
  MODEL_NOT_FOUND: "或调用地址不存在。",
  INVALID_REQUEST: "拒绝了请求，模型能力或接口格式可能不兼容。",
  SERVICE_UNAVAILABLE: "供应商服务暂时不可用。",
  INVALID_RESPONSE: "返回格式不符合要求。",
  REQUEST_FAILED: "调用失败，未能确定具体原因。",
  OUTPUT_TRUNCATED: "回复被截断，分析结果不完整。",
  EMPTY: "没有返回分析结果。",
  INVALID_OUTPUT: "没有返回要求的分析格式。",
  INVALID_FIELD: "返回的分析字段不符合要求。",
  INVALID_LIST: "返回的关键词或信息列表不符合要求。",
  INVALID_ENTITY: "返回的人物或项目识别结果不符合要求。",
  UNGROUNDED_SUMMARY: "生成了原资料没有提供的信息，结果已被拦截。",
  DIMENSIONS_CHANGED: "返回了不一致的向量维度。",
  VECTOR_COUNT_MISMATCH: "返回的向量数量与资料片段数量不一致。",
};
const systemDescriptions: Readonly<Record<string, string>> = {
  MATERIAL_INGESTION_UNEXPECTED: "处理资料时发生未能识别的系统异常。",
  MATERIAL_SOURCE_NOT_FOUND: "任务对应的资料记录不存在。",
  MATERIAL_CHUNKS_MISSING: "资料缺少重建检索索引所需的文字片段。",
  EMPTY_EMBEDDING_INPUT: "处理任务没有生成可用于建立检索索引的内容。",
  ARTIFACT_NOT_LOADED: "处理任务未能加载原文件，需检查文件读取链路。",
  BUNDLE_MATERIAL_TYPE_UNSUPPORTED: "处理任务的资料类型与附件处理方式不一致。",
  BUNDLE_ARTIFACT_COUNT_INVALID: "处理任务中的附件数量不符合处理要求。",
  RUNTIME_POLICY_MISSING: "平台运行配置缺失。",
  STORAGE_READ_FAILED: "暂时无法从存储服务读取原文件。",
  STORAGE_ACCESS_DENIED: "存储服务拒绝访问原文件。",
  TENANT_STORAGE_LIMIT_EXCEEDED: "客户的存储空间不足。",
  STORAGE_RESERVATION_INVALID: "存储容量申请无效。",
  STORAGE_RESERVATION_KEY_REUSED: "存储容量记录发生冲突。",
  STORAGE_RESERVATION_RELEASED: "存储容量申请已失效。",
  STORAGE_RESERVATION_NOT_FOUND: "存储容量记录不存在。",
  STORAGE_RESERVATION_ALREADY_COMMITTED: "存储容量记录状态不一致。",
  STORAGE_ACCOUNT_LOCK_FAILED: "存储容量记录锁定失败。",
  STORAGE_TRANSACTION_RETRY_EXHAUSTED: "存储容量更新重试后仍未完成。",
  LINK_DNS_EMPTY: "公开链接域名解析失败。",
  LINK_FETCH_TIMEOUT: "读取公开链接超时。",
  LINK_FETCH_NETWORK: "连接公开链接失败。",
};

export function processingIssueGuidance(
  rawCode: string | null,
): Pick<
  ProcessingIssueDto,
  "errorCode" | "stage" | "reason" | "suggestedActions" | "settingsPath"
> {
  const code = rawCode ?? "UNCLASSIFIED";
  if (Object.hasOwn(fileDescriptions, code)) {
    return {
      errorCode: code,
      stage: "FILE",
      reason: fileDescriptions[code] ?? "原文件需要检查。",
      suggestedActions: [
        "联系提交用户，按失败原因检查文件或资料内容。",
        "通过“更新内容”提交可读取的原文件；不要反复处理同一坏文件。",
      ],
      settingsPath: null,
    };
  }
  for (const [prefix, stage, label] of [
    ["MATERIAL_ANALYSIS", "ANALYSIS", "资料理解模型"],
    ["EMBEDDING", "EMBEDDING", "向量检索模型"],
  ] as const) {
    const suffix = code.startsWith(`${prefix}_`) ? code.slice(prefix.length + 1) : "";
    if (!Object.hasOwn(modelDescriptions, suffix)) continue;
    const check =
      suffix === "MODEL_NOT_ALLOWED"
        ? "在供应商后台检查 API Key 的模型访问权限，或选择当前密钥已获授权的模型。"
        : suffix === "QUOTA_EXCEEDED"
          ? "检查供应商账户余额、额度和套餐，恢复可用额度。"
          : suffix === "AUTH_FAILED" || suffix === "CREDENTIAL_UNAVAILABLE"
            ? "检查供应商密钥、模型访问权限和运行节点的凭据解密配置。"
            : "检查平台模型选择、供应商连接、模型能力和返回格式；必要时更换兼容模型。";
    return {
      errorCode: code,
      stage,
      reason: `${label}${modelDescriptions[suffix]}`,
      suggestedActions: [check, "修复后在本面板重新处理原资料；无需让用户重新上传。"],
      settingsPath: "/platform/models",
    };
  }
  const linkStatus = /^LINK_HTTP_([45]\d{2})$/u.exec(code)?.[1];
  if (linkStatus && (linkStatus.startsWith("5") || linkStatus === "429"))
    return {
      errorCode: code,
      stage: "SYSTEM",
      reason: `公开链接服务返回 HTTP ${linkStatus}，暂时无法读取。`,
      suggestedActions: [
        "检查目标网站可用性、调用限制和 Worker 出口网络连接。",
        "目标服务恢复后重新处理；无需用户重复上传原资料。",
      ],
      settingsPath: "/platform/settings/worker",
    };
  if (linkStatus)
    return {
      errorCode: code,
      stage: "FILE",
      reason: `公开链接返回 HTTP ${linkStatus}。`,
      suggestedActions: [
        "确认链接公开可访问，并检查网站响应状态。",
        "链接地址有误时，请用户更新资料内容。",
      ],
      settingsPath: null,
    };
  if (Object.hasOwn(systemDescriptions, code)) {
    const storage = code.startsWith("STORAGE_") || code === "TENANT_STORAGE_LIMIT_EXCEEDED";
    return {
      errorCode: code,
      stage: storage ? "STORAGE" : "SYSTEM",
      reason: systemDescriptions[code] ?? "系统处理异常。",
      suggestedActions: [
        storage
          ? "检查对象存储服务连接、访问权限和客户存储容量。"
          : "检查内容 Worker、队列和运行日志，并使用任务ID定位异常。",
        "服务恢复后重新处理；尚未明确原因时不要反复点击重试。",
      ],
      settingsPath: storage ? "/platform/settings/storage" : "/platform/settings/worker",
    };
  }
  return {
    errorCode: "UNCLASSIFIED",
    stage: "SYSTEM",
    reason: "任务处理失败，现有记录未提供可确认的失败原因。",
    suggestedActions: [
      "使用任务ID和发生时间检查 Worker 运行日志，确认具体失败环节。",
      "确认服务已恢复后重新处理原资料。",
    ],
    settingsPath: "/platform/settings/worker",
  };
}
