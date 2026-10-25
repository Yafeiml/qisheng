import type { PlatformSettingGroup, PlatformSettingValueType } from "@xhs-agentic/database";

export type PlatformSettingScalar = boolean | number | string | null;

export type PlatformSettingOption = Readonly<{
  label: string;
  value: string;
}>;

export type RuntimePolicyField =
  | "costCurrency"
  | "costWarningThreshold"
  | "embeddingModelId"
  | "materialAnalysisModelId"
  | "materialChunkOverlapCharacters"
  | "materialChunkSizeCharacters"
  | "maxActiveGenerationJobs"
  | "maxProviderConcurrentInvocations"
  | "maxQueueBacklog"
  | "minimumGenerationWorkers"
  | "providerHealthMaxAgeSeconds"
  | "retrievalMaxContextCharacters"
  | "retrievalStrategyVersion"
  | "retrievalTopK"
  | "routeQualificationMaxAgeSeconds";

export type PlatformSettingDefinition = Readonly<{
  defaultValue: PlatformSettingScalar;
  description: string;
  environmentVariable?: string;
  group: PlatformSettingGroup;
  key: string;
  label: string;
  max?: number;
  maxLength?: number;
  min?: number;
  minLength?: number;
  nullable?: boolean;
  options?: readonly PlatformSettingOption[];
  pattern?: string;
  restartRequired?: boolean;
  runtimeField?: RuntimePolicyField;
  step?: number;
  store: "PLATFORM_SETTING" | "RUNTIME_POLICY";
  unit?: string;
  valueType: PlatformSettingValueType;
}>;

export const platformSettingGroups = [
  {
    description: "平台名称、默认时区、员工任务有效期和客户服务信息。",
    group: "GENERAL",
    label: "常用设置",
    mark: "常",
    slug: "general",
  },
  {
    description: "正式生成资格、队列容量、并发与成本告警阈值。",
    group: "GENERATION",
    label: "生成设置",
    mark: "生",
    slug: "generation",
  },
  {
    description: "Embedding、素材分块、召回数量与上下文上限。",
    group: "RETRIEVAL",
    label: "检索设置",
    mark: "检",
    slug: "retrieval",
  },
  {
    description: "生成与素材 Worker 的并发、租约、重试和熔断参数；修改后需重启 Worker。",
    group: "WORKER",
    label: "Worker 设置",
    mark: "工",
    slug: "worker",
  },
  {
    description: "部署服务器本机存储或 S3 兼容存储、私有访问和签名地址有效期。",
    group: "STORAGE",
    label: "存储设置",
    mark: "存",
    slug: "storage",
  },
  {
    description: "生成图文在进入人工审核前执行外部多模态安全复核；生产模式失败关闭。",
    group: "CONTENT_SAFETY",
    label: "内容安全",
    mark: "审",
    slug: "content-safety",
  },
  {
    description: "公开链接解析、图文匹配、版本化验真策略与指标回填密钥。",
    group: "PUBLICATION",
    label: "发布验真",
    mark: "验",
    slug: "publication",
  },
  {
    description: "账号密码、可选 Cap 验证和后台会话期限。",
    group: "SECURITY",
    label: "安全设置",
    mark: "安",
    slug: "security",
  },
  {
    description: "可选 SMTP 管理员邮箱验证及模型故障邮件提醒。",
    group: "NOTIFICATION",
    label: "通知设置",
    mark: "通",
    slug: "notification",
  },
  {
    description: "员工小程序身份接入、任务订阅消息及临时验证码通道。",
    group: "MINIAPP",
    label: "小程序设置",
    mark: "微",
    slug: "miniapp",
  },
] as const satisfies readonly Readonly<{
  description: string;
  group: PlatformSettingGroup;
  label: string;
  mark: string;
  slug: string;
}>[];

const currencyOptions = ["CNY", "USD", "HKD"].map((value) => ({ label: value, value }));

export const platformSettingCatalog = [
  setting(
    "general.platform_name",
    "GENERAL",
    "STRING",
    "平台显示名称",
    "用于 SaaS 平台标题与对外识别。",
    "企声发布",
    {
      maxLength: 60,
      minLength: 2,
    },
  ),
  setting(
    "general.platform_logo",
    "GENERAL",
    "STRING",
    "平台 Logo",
    "上传 1:1 的 PNG、JPEG 或 WebP 图片，统一用于登录页与后台品牌标志；留空恢复默认标志。",
    "",
    { maxLength: 82_000, pattern: "^$|^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$" },
  ),
  setting(
    "general.default_timezone",
    "GENERAL",
    "ENUM",
    "默认业务时区",
    "用于后台计划时间和经营日期的默认解释。",
    "Asia/Shanghai",
    {
      options: [
        { label: "中国标准时间（Asia/Shanghai）", value: "Asia/Shanghai" },
        { label: "香港时间（Asia/Hong_Kong）", value: "Asia/Hong_Kong" },
        { label: "协调世界时（UTC）", value: "UTC" },
      ],
    },
  ),
  setting(
    "general.task_expiry_hours",
    "GENERAL",
    "INTEGER",
    "员工任务有效时长",
    "从统一解锁时间开始计算，超时后员工任务自动失效。",
    24,
    {
      max: 168,
      min: 1,
      unit: "小时",
    },
  ),
  setting(
    "general.customer_service_phone",
    "GENERAL",
    "STRING",
    "客服电话",
    "展示给客户管理员的服务联系电话；可留空。",
    "",
    {
      maxLength: 32,
      pattern: "^[0-9+() -]*$",
    },
  ),
  setting(
    "general.support_email",
    "GENERAL",
    "STRING",
    "支持邮箱",
    "展示给客户管理员的服务邮箱；可留空。",
    "",
    {
      maxLength: 160,
      pattern: "^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    },
  ),

  runtimeSetting(
    "generation.provider_health_max_age_seconds",
    "GENERATION",
    "INTEGER",
    "供应商连接检查缓存时间",
    "系统在读取状态和生成前自动复查超过该时间的连接记录，无需管理员定时重测。",
    "providerHealthMaxAgeSeconds",
    900,
    {
      max: 86_400,
      min: 30,
      unit: "秒",
    },
  ),
  runtimeSetting(
    "generation.minimum_workers",
    "GENERATION",
    "INTEGER",
    "最少生成 Worker",
    "每个生成队列要求在线的最少消费者数量，默认 1。一个 Worker 容器可同时处理多个队列，可与主服务同机部署，无需独立服务器。",
    "minimumGenerationWorkers",
    1,
    {
      max: 1_000,
      min: 1,
    },
  ),
  runtimeSetting(
    "generation.max_queue_backlog",
    "GENERATION",
    "INTEGER",
    "最大队列积压",
    "超过该积压量时阻止创建新的正式生成活动。",
    "maxQueueBacklog",
    10_000,
    {
      max: 1_000_000,
      min: 1,
    },
  ),
  runtimeSetting(
    "generation.max_active_jobs",
    "GENERATION",
    "INTEGER",
    "最大活跃生成任务",
    "平台允许同时处于活跃状态的生成工作项上限。",
    "maxActiveGenerationJobs",
    1_000,
    {
      max: 1_000_000,
      min: 1,
    },
  ),
  runtimeSetting(
    "generation.max_provider_concurrency",
    "GENERATION",
    "INTEGER",
    "单 Provider 最大并发",
    "Provider 调用租约允许的全局并发上限。",
    "maxProviderConcurrentInvocations",
    10,
    {
      max: 10_000,
      min: 1,
    },
  ),
  runtimeSetting(
    "generation.cost_warning_threshold",
    "GENERATION",
    "DECIMAL",
    "单活动成本告警阈值",
    "活动预计模型成本超过该值时进入平台告警。",
    "costWarningThreshold",
    100,
    {
      min: 0,
      step: 0.01,
    },
  ),
  runtimeSetting(
    "generation.cost_currency",
    "GENERATION",
    "ENUM",
    "成本币种",
    "平台模型成本与告警阈值使用的币种。",
    "costCurrency",
    "CNY",
    {
      options: currencyOptions,
    },
  ),

  runtimeSetting(
    "retrieval.material_analysis_model_id",
    "RETRIEVAL",
    "ENUM",
    "资料理解模型",
    "自动识别文本、文档和图片，提炼人物、项目及检索关键词。需支持文本和视觉；留空时沿用平台文案模型（图片仍要求视觉能力）。",
    "materialAnalysisModelId",
    null,
    { nullable: true },
  ),
  runtimeSetting(
    "retrieval.embedding_model_id",
    "RETRIEVAL",
    "ENUM",
    "Embedding 模型",
    "只允许选择平台已启用的真实 Embedding 模型；留空时使用开发确定性向量。",
    "embeddingModelId",
    null,
    {
      nullable: true,
    },
  ),
  runtimeSetting(
    "retrieval.top_k",
    "RETRIEVAL",
    "INTEGER",
    "召回证据数量",
    "每次活动素材检索最多冻结的相关证据片段数量。",
    "retrievalTopK",
    8,
    {
      max: 50,
      min: 1,
    },
  ),
  runtimeSetting(
    "retrieval.max_context_characters",
    "RETRIEVAL",
    "INTEGER",
    "最大检索上下文",
    "送入活动母版生成的证据上下文字符上限。",
    "retrievalMaxContextCharacters",
    12_000,
    {
      max: 100_000,
      min: 1_000,
      unit: "字符",
    },
  ),
  runtimeSetting(
    "retrieval.chunk_size_characters",
    "RETRIEVAL",
    "INTEGER",
    "素材分块大小",
    "新入库素材切分为检索 Chunk 时的目标字符数。",
    "materialChunkSizeCharacters",
    1_200,
    {
      max: 10_000,
      min: 200,
      unit: "字符",
    },
  ),
  runtimeSetting(
    "retrieval.chunk_overlap_characters",
    "RETRIEVAL",
    "INTEGER",
    "素材分块重叠",
    "相邻 Chunk 之间保留的上下文字符数，必须小于分块大小。",
    "materialChunkOverlapCharacters",
    160,
    {
      max: 2_000,
      min: 0,
      unit: "字符",
    },
  ),
  runtimeSetting(
    "retrieval.strategy_version",
    "RETRIEVAL",
    "STRING",
    "检索策略版本",
    "写入活动冻结证据，便于历史活动解释与回放。",
    "retrievalStrategyVersion",
    "hybrid-v1",
    {
      maxLength: 120,
      minLength: 2,
    },
  ),

  setting(
    "worker.generation_concurrency",
    "WORKER",
    "INTEGER",
    "生成 Worker 并发",
    "单个 Worker 进程同时处理的 BullMQ 生成任务数量。",
    4,
    {
      environmentVariable: "GENERATION_WORKER_CONCURRENCY",
      max: 128,
      min: 1,
      restartRequired: true,
    },
  ),
  setting(
    "worker.generation_rate_limit",
    "WORKER",
    "INTEGER",
    "生成速率上限",
    "单个 Worker 每秒最多开始的生成任务数量。",
    10,
    {
      environmentVariable: "GENERATION_WORKER_RATE_LIMIT",
      max: 1_000,
      min: 1,
      restartRequired: true,
      unit: "次/秒",
    },
  ),
  setting(
    "worker.generation_lease_duration_ms",
    "WORKER",
    "INTEGER",
    "生成租约时长",
    "工作项执行租约的有效期；必须大于心跳间隔的两倍。",
    120_000,
    {
      environmentVariable: "GENERATION_LEASE_DURATION_MS",
      max: 1_800_000,
      min: 30_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),
  setting(
    "worker.generation_heartbeat_interval_ms",
    "WORKER",
    "INTEGER",
    "生成心跳间隔",
    "Worker 刷新执行租约的间隔。",
    15_000,
    {
      environmentVariable: "GENERATION_HEARTBEAT_INTERVAL_MS",
      max: 300_000,
      min: 1_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),
  setting(
    "worker.generation_reconcile_interval_ms",
    "WORKER",
    "INTEGER",
    "生成恢复扫描间隔",
    "扫描遗漏队列任务和过期租约的时间间隔。",
    60_000,
    {
      environmentVariable: "GENERATION_RECONCILE_INTERVAL_MS",
      max: 1_800_000,
      min: 5_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),
  setting(
    "worker.material_ingestion_concurrency",
    "WORKER",
    "INTEGER",
    "素材入库并发",
    "单个 Worker 同时解析和索引的素材任务数量。",
    2,
    {
      environmentVariable: "MATERIAL_INGESTION_CONCURRENCY",
      max: 32,
      min: 1,
      restartRequired: true,
    },
  ),
  setting(
    "worker.material_reconcile_interval_ms",
    "WORKER",
    "INTEGER",
    "素材恢复扫描间隔",
    "扫描遗漏素材入库任务的时间间隔。",
    30_000,
    {
      environmentVariable: "MATERIAL_INGESTION_RECONCILE_INTERVAL_MS",
      max: 1_800_000,
      min: 5_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),
  setting(
    "worker.provider_circuit_failure_threshold",
    "WORKER",
    "INTEGER",
    "Provider 熔断失败阈值",
    "连续失败达到该数量时打开 Provider 熔断器。",
    5,
    {
      environmentVariable: "PROVIDER_CIRCUIT_FAILURE_THRESHOLD",
      max: 100,
      min: 1,
      restartRequired: true,
    },
  ),
  setting(
    "worker.provider_circuit_cooldown_ms",
    "WORKER",
    "INTEGER",
    "Provider 熔断冷却",
    "熔断打开后等待进入半开探测的时间。",
    60_000,
    {
      environmentVariable: "PROVIDER_CIRCUIT_COOLDOWN_MS",
      max: 3_600_000,
      min: 1_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),
  setting(
    "worker.provider_circuit_probe_lease_ms",
    "WORKER",
    "INTEGER",
    "半开探针租约",
    "防止多个 Worker 同时执行 Provider 半开探测。",
    120_000,
    {
      environmentVariable: "PROVIDER_CIRCUIT_PROBE_LEASE_MS",
      max: 3_600_000,
      min: 5_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),

  setting(
    "storage.provider",
    "STORAGE",
    "ENUM",
    "存储方式",
    "本机存储保存在部署服务器的持久化目录；S3 使用兼容对象存储。已有文件或进行中的任务时不能直接切换，切换前需完成迁移并停止相关任务，保存后需重启 Worker。",
    "S3",
    {
      environmentVariable: "OBJECT_STORAGE_PROVIDER",
      options: [
        { label: "本机存储", value: "LOCAL" },
        { label: "S3 兼容存储", value: "S3" },
      ],
      restartRequired: true,
    },
  ),
  setting(
    "storage.versioning_required",
    "STORAGE",
    "BOOLEAN",
    "强制版本控制",
    "默认开启：生产验收要求 Bucket 版本控制和历史版本生命周期。关闭后跳过这两项要求，仍检查连接、正式凭据与私有交付；无法依靠存储历史版本恢复误覆盖或误删除的数据。此开关不修改云端已有版本控制或清理规则，保存后立即生效。",
    true,
  ),
  setting(
    "storage.endpoint",
    "STORAGE",
    "URL",
    "对象存储 Endpoint",
    "S3、OSS 或 MinIO 的兼容 API 地址。",
    null,
    {
      environmentVariable: "OBJECT_STORAGE_ENDPOINT",
      nullable: true,
      restartRequired: true,
    },
  ),
  setting(
    "storage.region",
    "STORAGE",
    "STRING",
    "对象存储 Region",
    "对象存储客户端使用的区域标识。",
    "us-east-1",
    {
      environmentVariable: "OBJECT_STORAGE_REGION",
      maxLength: 100,
      minLength: 1,
      restartRequired: true,
    },
  ),
  setting(
    "storage.bucket",
    "STORAGE",
    "STRING",
    "私有 Bucket",
    "生成图片与素材原文件所在的私有 Bucket。",
    null,
    {
      environmentVariable: "OBJECT_STORAGE_BUCKET",
      maxLength: 63,
      minLength: 3,
      nullable: true,
      pattern: "^[a-z0-9][a-z0-9.-]+[a-z0-9]$",
      restartRequired: true,
    },
  ),
  setting(
    "storage.access_key_id",
    "STORAGE",
    "SECRET",
    "Access Key ID",
    "对象存储访问标识；数据库中加密保存，前端只显示尾号。",
    null,
    {
      environmentVariable: "OBJECT_STORAGE_ACCESS_KEY",
      minLength: 3,
      nullable: true,
      restartRequired: true,
    },
  ),
  setting(
    "storage.secret_access_key",
    "STORAGE",
    "SECRET",
    "Secret Access Key",
    "对象存储访问密钥；数据库中加密保存，永不返回明文。",
    null,
    {
      environmentVariable: "OBJECT_STORAGE_SECRET_KEY",
      minLength: 8,
      nullable: true,
      restartRequired: true,
    },
  ),
  setting(
    "storage.force_path_style",
    "STORAGE",
    "BOOLEAN",
    "强制 Path Style",
    "MinIO 和部分 S3 兼容服务通常需要启用。",
    true,
    {
      environmentVariable: "OBJECT_STORAGE_FORCE_PATH_STYLE",
      restartRequired: true,
    },
  ),
  setting(
    "storage.signed_url_ttl_seconds",
    "STORAGE",
    "INTEGER",
    "签名地址有效期",
    "员工图片、素材预览和上传地址的短期有效时间。",
    900,
    {
      max: 3_600,
      min: 60,
      unit: "秒",
    },
  ),
  setting(
    "storage.delivery_mode",
    "STORAGE",
    "ENUM",
    "图片交付模式",
    "S3 签名地址适合直接交付；Edge 签名地址可由 CDN 回源平台只读资产接口。",
    "S3_SIGNED",
    {
      environmentVariable: "ASSET_DELIVERY_MODE",
      options: [
        { label: "S3/OSS 短期签名地址", value: "S3_SIGNED" },
        { label: "CDN / Edge 短期签名地址", value: "EDGE_SIGNED" },
      ],
    },
  ),
  setting(
    "storage.delivery_base_url",
    "STORAGE",
    "URL",
    "CDN 交付域名",
    "Edge 模式下用于生成 /assets/{token} 地址；CDN 需要将该路径回源到 API。",
    null,
    {
      environmentVariable: "ASSET_DELIVERY_BASE_URL",
      nullable: true,
    },
  ),
  setting(
    "storage.delivery_signing_key",
    "STORAGE",
    "SECRET",
    "资产交付签名密钥",
    "Edge 模式使用的独立 HMAC 密钥，数据库中加密保存且客户侧永不返回。",
    null,
    {
      environmentVariable: "ASSET_DELIVERY_SIGNING_KEY",
      minLength: 32,
      nullable: true,
    },
  ),
  setting(
    "storage.noncurrent_version_expiration_days",
    "STORAGE",
    "INTEGER",
    "历史对象版本保留期",
    "启用 Bucket 版本控制后，已被覆盖或删除的旧版本保留天数；当前有效对象不会按年龄自动删除。",
    30,
    {
      max: 3650,
      min: 1,
      unit: "天",
    },
  ),
  setting(
    "storage.abort_incomplete_upload_days",
    "STORAGE",
    "INTEGER",
    "未完成分片上传清理期",
    "自动终止长期未完成的 Multipart Upload，避免无主分片持续占用存储费用。",
    1,
    {
      max: 30,
      min: 1,
      unit: "天",
    },
  ),

  setting(
    "content_safety.mode",
    "CONTENT_SAFETY",
    "ENUM",
    "内容安全模式",
    "生产交付可使用现有多模态模型审核，或接入独立审核服务。",
    "DISABLED",
    {
      environmentVariable: "CONTENT_SAFETY_MODE",
      options: [
        { label: "使用现有多模态模型", value: "MODEL" },
        { label: "关闭（仅限开发）", value: "DISABLED" },
        { label: "独立 HTTP 审核服务", value: "HTTP" },
      ],
      restartRequired: true,
    },
  ),
  setting(
    "content_safety.model_provider_id",
    "CONTENT_SAFETY",
    "STRING",
    "审核模型供应商",
    "复用模型供应商中已保存的连接和密钥。",
    "",
    { maxLength: 100, restartRequired: true },
  ),
  setting(
    "content_safety.model",
    "CONTENT_SAFETY",
    "STRING",
    "图文审核模型",
    "选择支持图片理解的模型，保存后运行图文审核测试。",
    "",
    { maxLength: 200, restartRequired: true },
  ),
  setting(
    "content_safety.provider",
    "CONTENT_SAFETY",
    "STRING",
    "审核服务标识",
    "写入审核证据和运行日志的供应商标识，不向客户展示。",
    "",
    {
      environmentVariable: "CONTENT_SAFETY_PROVIDER",
      maxLength: 80,
      pattern: "^[A-Za-z0-9_.-]*$",
      restartRequired: true,
    },
  ),
  setting(
    "content_safety.endpoint",
    "CONTENT_SAFETY",
    "URL",
    "审核服务 Endpoint",
    "接收图文 Base64、校验和与幂等请求号的专用审核接口；生产环境必须使用 HTTPS。",
    null,
    {
      environmentVariable: "CONTENT_SAFETY_ENDPOINT",
      nullable: true,
      restartRequired: true,
    },
  ),
  setting(
    "content_safety.api_key",
    "CONTENT_SAFETY",
    "SECRET",
    "审核服务 API Key",
    "由 SaaS 管理员维护并加密保存，客户侧永不返回明文。",
    null,
    {
      environmentVariable: "CONTENT_SAFETY_API_KEY",
      minLength: 4,
      nullable: true,
      restartRequired: true,
    },
  ),
  setting(
    "content_safety.timeout_ms",
    "CONTENT_SAFETY",
    "INTEGER",
    "单次审核超时",
    "图文安全审核的请求超时；网络或 5xx 失败会按生成任务策略重试。",
    30_000,
    {
      environmentVariable: "CONTENT_SAFETY_TIMEOUT_MS",
      max: 120_000,
      min: 1_000,
      restartRequired: true,
      unit: "毫秒",
    },
  ),

  setting(
    "publication.mode",
    "PUBLICATION",
    "ENUM",
    "公开内容验真模式",
    "默认由管理员人工复核发布回填；HTTP 和浏览器适配器为已有安装保留，自动回读在发布回读页面按需启用。",
    "MANUAL",
    {
      environmentVariable: "PUBLICATION_VERIFICATION_MODE",
      options: [
        { label: "管理员人工复核", value: "MANUAL" },
        { label: "本机开发样本", value: "DEVELOPMENT" },
        { label: "HTTP 公开内容验真服务", value: "HTTP" },
        { label: "Windows 浏览器异步工作单", value: "BROWSER" },
      ],
    },
  ),
  setting(
    "publication.readback_enabled",
    "PUBLICATION",
    "BOOLEAN",
    "自动回读",
    "可选功能；保存接口和凭据并完成样本验证后，在发布回读页面启用。",
    false,
    { environmentVariable: "PUBLICATION_READBACK_ENABLED" },
  ),
  setting(
    "publication.readback_endpoint",
    "PUBLICATION",
    "STRING",
    "笔记详情接口",
    "由部署者填写兼容 GET noteId 协议的公开 HTTPS 接口；Token 单独配置。",
    "",
    { maxLength: 8192 },
  ),
  setting(
    "publication.readback_token",
    "PUBLICATION",
    "SECRET",
    "回读供应商 Token",
    "加密保存，仅向已签名的同机采集任务提供，不进入普通状态或审计响应。",
    null,
    { minLength: 1, maxLength: 4096, nullable: true },
  ),
  setting(
    "publication.provider",
    "PUBLICATION",
    "STRING",
    "验真服务标识",
    "写入验证尝试、审计和运行诊断的供应商标识，不向员工展示。",
    "",
    {
      environmentVariable: "PUBLICATION_VERIFICATION_PROVIDER",
      maxLength: 80,
      pattern: "^[A-Za-z0-9_.-]*$",
    },
  ),
  setting(
    "publication.endpoint",
    "PUBLICATION",
    "URL",
    "验真服务 Endpoint",
    "接收小红书公开链接并返回规范链接、公开正文和图片指纹；生产环境必须使用 HTTPS。",
    null,
    {
      environmentVariable: "PUBLICATION_VERIFICATION_ENDPOINT",
      nullable: true,
    },
  ),
  setting(
    "publication.api_key",
    "PUBLICATION",
    "SECRET",
    "验真服务 API Key",
    "由 SaaS 管理员维护并加密保存，集团、企业、员工和审计日志均不返回明文。",
    null,
    {
      environmentVariable: "PUBLICATION_VERIFICATION_API_KEY",
      minLength: 4,
      nullable: true,
    },
  ),
  setting(
    "publication.timeout_ms",
    "PUBLICATION",
    "INTEGER",
    "单次验真超时",
    "公开链接解析与图文指纹返回的请求超时；失败时保留员工按时提交事实，不判定未完成。",
    30_000,
    {
      environmentVariable: "PUBLICATION_VERIFICATION_TIMEOUT_MS",
      max: 120_000,
      min: 1_000,
      unit: "毫秒",
    },
  ),
  setting(
    "publication.policy_version",
    "PUBLICATION",
    "STRING",
    "验真策略版本",
    "随每次验证尝试冻结，调整阈值后不改写历史判定依据。",
    "xhs-public-v1",
    {
      maxLength: 120,
      minLength: 2,
      pattern: "^[A-Za-z0-9_.-]+$",
    },
  ),
  setting(
    "publication.text_similarity_threshold",
    "PUBLICATION",
    "DECIMAL",
    "正文自动通过阈值",
    "公开标题、正文和标签与员工最终文案的综合相似度达到该值才允许自动通过。",
    0.72,
    {
      max: 1,
      min: 0,
      step: 0.01,
    },
  ),
  setting(
    "publication.image_similarity_threshold",
    "PUBLICATION",
    "DECIMAL",
    "图片自动通过阈值",
    "公开图片指纹与员工独立图片的最高相似度达到该值才允许自动通过。",
    0.8,
    {
      max: 1,
      min: 0,
      step: 0.01,
    },
  ),
  setting(
    "publication.manual_review_margin",
    "PUBLICATION",
    "DECIMAL",
    "人工复核灰区宽度",
    "自动分数低于通过阈值但仍落在该差值范围内时进入人工复核，而不是直接判定不匹配。",
    0.08,
    {
      max: 0.5,
      min: 0,
      step: 0.01,
    },
  ),
  setting(
    "publication.require_image_match",
    "PUBLICATION",
    "BOOLEAN",
    "要求图片匹配",
    "开启后至少一张公开图片必须与该员工的独立图片匹配；无法取得图片指纹时进入人工复核。",
    true,
  ),
  setting(
    "publication.metrics_ingest_key",
    "SECURITY",
    "SECRET",
    "公开指标回填密钥",
    "Hermes 或其他受控采集服务使用的 HMAC 密钥，只允许平台管理员维护。",
    null,
    {
      environmentVariable: "HERMES_INGEST_KEY",
      minLength: 32,
      nullable: true,
    },
  ),

  setting(
    "security.admin_sms_access_key_id",
    "SECURITY",
    "SECRET",
    "ACCESS_KEY_ID",
    "阿里云短信 AccessKey ID，加密保存。",
    null,
    {
      environmentVariable: "ALIYUN_SMS_ACCESS_KEY_ID",
      nullable: true,
      minLength: 1,
      maxLength: 256,
    },
  ),
  setting(
    "security.admin_sms_access_key_secret",
    "SECURITY",
    "SECRET",
    "ACCESS_KEY_SECRET",
    "阿里云短信 AccessKey Secret，加密保存且不回显。",
    null,
    {
      environmentVariable: "ALIYUN_SMS_ACCESS_KEY_SECRET",
      nullable: true,
      minLength: 1,
      maxLength: 256,
    },
  ),
  setting(
    "security.admin_sms_sign_name",
    "SECURITY",
    "STRING",
    "SIGN_NAME（签名名称）",
    "阿里云已审核通过的短信签名名称。",
    "",
    { environmentVariable: "ALIYUN_SMS_SIGN_NAME", maxLength: 80 },
  ),
  setting(
    "security.admin_sms_template_code",
    "SECURITY",
    "STRING",
    "TEMPLATE_CODE（模板 CODE）",
    "阿里云验证码模板 CODE，验证码变量名为 code。",
    "",
    { environmentVariable: "ALIYUN_SMS_TEMPLATE_CODE", maxLength: 64, pattern: "^(SMS_[0-9]+)?$" },
  ),
  setting(
    "security.admin_sms_mode",
    "SECURITY",
    "ENUM",
    "管理员验证码通道",
    "本机开发可使用固定验证码；保存阿里云四项配置后自动切换为真实短信发送。",
    "DEVELOPMENT",
    {
      environmentVariable: "ADMIN_SMS_MODE",
      options: [
        { label: "本机开发适配器", value: "DEVELOPMENT" },
        { label: "HTTP 短信网关", value: "HTTP" },
        { label: "阿里云短信", value: "ALIYUN" },
      ],
    },
  ),
  setting(
    "security.admin_sms_provider",
    "SECURITY",
    "STRING",
    "短信供应商标识",
    "写入发送审计的短信服务或受控网关标识。",
    "",
    {
      environmentVariable: "ADMIN_SMS_PROVIDER",
      maxLength: 80,
      pattern: "^[A-Za-z0-9_.-]*$",
    },
  ),
  setting(
    "security.admin_sms_endpoint",
    "SECURITY",
    "URL",
    "短信网关 Endpoint",
    "接收手机号、验证码、有效期、模板和幂等请求号；生产环境必须使用 HTTPS。",
    null,
    {
      environmentVariable: "ADMIN_SMS_ENDPOINT",
      nullable: true,
    },
  ),
  setting(
    "security.admin_sms_api_key",
    "SECURITY",
    "SECRET",
    "短信网关 API Key",
    "由 SaaS 管理员加密保存，登录接口、客户后台和审计日志均不返回明文。",
    null,
    {
      environmentVariable: "ADMIN_SMS_API_KEY",
      minLength: 4,
      nullable: true,
    },
  ),
  setting(
    "security.admin_sms_sender",
    "SECURITY",
    "STRING",
    "短信签名",
    "短信服务使用的签名或发送方名称。",
    "",
    {
      environmentVariable: "ADMIN_SMS_SENDER",
      maxLength: 80,
    },
  ),
  setting(
    "security.admin_sms_template_id",
    "SECURITY",
    "STRING",
    "登录验证码模板 ID",
    "短信供应商侧已审核通过的管理员登录验证码模板。",
    "",
    {
      environmentVariable: "ADMIN_SMS_TEMPLATE_ID",
      maxLength: 160,
    },
  ),
  setting(
    "security.admin_sms_timeout_ms",
    "SECURITY",
    "INTEGER",
    "短信发送超时",
    "短信网关单次请求超时；失败时验证码和冷却状态会回滚，允许管理员重新请求。",
    10_000,
    {
      environmentVariable: "ADMIN_SMS_TIMEOUT_MS",
      max: 60_000,
      min: 1_000,
      unit: "毫秒",
    },
  ),
  setting(
    "security.admin_refresh_token_ttl_seconds",
    "SECURITY",
    "INTEGER",
    "管理员会话最长有效期",
    "新登录会话的 Refresh Token 最长有效时间；已有会话不追溯修改。",
    2_592_000,
    {
      environmentVariable: "ADMIN_REFRESH_TOKEN_TTL_SECONDS",
      max: 7_776_000,
      min: 3_600,
      unit: "秒",
    },
  ),
  setting(
    "security.max_active_admin_sessions",
    "SECURITY",
    "INTEGER",
    "单管理员最大活跃会话",
    "超过数量时自动撤销最久未使用的后台会话。",
    10,
    {
      max: 100,
      min: 1,
    },
  ),

  setting(
    "security.cap_enabled",
    "SECURITY",
    "BOOLEAN",
    "启用 Cap 验证",
    "可选。开启前必须配置 Cap 验证服务 Endpoint 和 Secret Key；开启后登录、注册和验证码均需安全验证。",
    false,
    { environmentVariable: "CAP_ENABLED" },
  ),
  setting(
    "security.cap_endpoint",
    "SECURITY",
    "URL",
    "Cap 验证服务 Endpoint",
    "填写 https://cap.example.com/<Site Key>/，Site Key 来自 Cap 控制台。当前客户端使用 SHA-256，站点需关闭 instrumentation。保存后用于登录、注册和员工验证码的人机验证。",
    null,
    {
      environmentVariable: "SMS_CAP_ENDPOINT",
      maxLength: 2048,
      nullable: true,
    },
  ),
  setting(
    "security.cap_secret",
    "SECURITY",
    "SECRET",
    "Cap 验证服务 Secret Key",
    "填写上述 Cap 站点的 Secret Key，仅服务端验票使用；加密保存，页面和审计日志不返回明文。",
    null,
    {
      environmentVariable: "SMS_CAP_SECRET",
      maxLength: 512,
      minLength: 1,
      nullable: true,
    },
  ),
  setting(
    "miniapp.wechat_app_id",
    "MINIAPP",
    "STRING",
    "微信小程序 AppID",
    "员工端微信身份和订阅消息使用的小程序 AppID；需与开发者工具及微信后台一致。",
    null,
    { nullable: true, maxLength: 18, pattern: "^wx[0-9a-f]{16}$" },
  ),
  setting(
    "miniapp.wechat_app_secret",
    "MINIAPP",
    "SECRET",
    "微信小程序 AppSecret",
    "用于服务端换取员工 OpenID 和微信接口凭证，加密保存且不回显；不要使用支付密钥代替。",
    null,
    { nullable: true, minLength: 32, maxLength: 32, pattern: "^[A-Za-z0-9]{32}$" },
  ),
  setting(
    "miniapp.debug_code_enabled",
    "MINIAPP",
    "BOOLEAN",
    "启用临时调试验证码",
    "仅允许下方列出的员工手机号使用临时验证码 000000；正式短信验证码接口不受影响。",
    false,
  ),
  setting(
    "miniapp.debug_code_phones",
    "MINIAPP",
    "STRING",
    "测试员工手机号",
    "最多 5 个中国大陆手机号，用英文逗号分隔；必须是具备绑定资格的员工。",
    "",
    { maxLength: 59 },
  ),
  setting(
    "miniapp.debug_code_ips",
    "MINIAPP",
    "STRING",
    "允许来源 IP",
    "最多 5 个 IPv4/IPv6 地址，用英文逗号分隔；填写 * 表示允许任意 IP。",
    "",
    { maxLength: 199 },
  ),
  setting(
    "miniapp.debug_code_until",
    "MINIAPP",
    "STRING",
    "调试通道截止时间",
    "填写未来 24 小时内的 UTC 时间（如 2026-09-27T12:00:00Z），或填写 never 表示不自动过期；每次领取的验证码仍只在 5 分钟内有效。",
    "",
    { maxLength: 20 },
  ),

  setting(
    "notification.registration_application_email",
    "NOTIFICATION",
    "STRING",
    "默认通知接收邮箱",
    "可选的系统通知邮箱；模型故障未单独配置收件人时使用。",
    "",
    { maxLength: 254, pattern: "^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
  ),
  setting(
    "notification.model_incident_email",
    "NOTIFICATION",
    "STRING",
    "模型故障接收邮箱",
    "连续任务重试失败触发门禁后通知管理员；留空时复用默认通知接收邮箱，SMTP 发件配置共用。",
    "",
    { maxLength: 254, pattern: "^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
  ),
  setting(
    "notification.registration_smtp_host",
    "NOTIFICATION",
    "STRING",
    "SMTP 服务器",
    "管理员邮箱验证、模型故障共用此发件服务。阿里云邮件推送默认使用 smtpdm.aliyun.com。",
    "smtpdm.aliyun.com",
    { maxLength: 253, pattern: "^$|^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$" },
  ),
  setting(
    "notification.registration_smtp_port",
    "NOTIFICATION",
    "INTEGER",
    "SMTP 端口",
    "默认 465 使用 SSL/TLS；其他端口强制 STARTTLS。",
    465,
    { min: 1, max: 65535 },
  ),
  setting(
    "notification.registration_smtp_username",
    "NOTIFICATION",
    "STRING",
    "SMTP 登录账号（选填）",
    "不填时使用下方发件地址登录。",
    "",
    { maxLength: 254 },
  ),
  setting(
    "notification.registration_smtp_password",
    "NOTIFICATION",
    "SECRET",
    "SMTP 授权密码",
    "阿里云发件地址的 SMTP 授权密码，加密保存；不要填写阿里云 API AccessKey。",
    null,
    { maxLength: 512, minLength: 1, nullable: true },
  ),
  setting(
    "notification.registration_smtp_sender",
    "NOTIFICATION",
    "STRING",
    "发件地址",
    "填写阿里云邮件推送中已经验证的发件邮箱。",
    "",
    { maxLength: 254, pattern: "^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" },
  ),
  setting(
    "notification.registration_smtp_from_name",
    "NOTIFICATION",
    "STRING",
    "发件名称",
    "展示在邮件发件人名称中，可按平台品牌调整。",
    "齐声共创",
    { maxLength: 80 },
  ),
  setting(
    "notification.enabled",
    "MINIAPP",
    "BOOLEAN",
    "素材开放通知总开关",
    "素材开放后提醒对应员工。短信使用已验证的员工手机号；微信订阅消息需要员工主动授权。",
    false,
  ),
  setting(
    "notification.channel",
    "MINIAPP",
    "ENUM",
    "默认通知渠道",
    "员工任务解锁时使用的通知渠道。",
    "WECHAT_TEMPLATE",
    {
      options: [
        { label: "阿里云短信", value: "ALIYUN_SMS" },
        { label: "微信小程序订阅消息", value: "WECHAT_TEMPLATE" },
        { label: "不发送通知", value: "NONE" },
      ],
    },
  ),
  setting(
    "notification.sms_template_code",
    "MINIAPP",
    "STRING",
    "素材开放短信模板代码",
    "填写阿里云审核通过的无变量通知模板 SMS_ 编号，独立于登录验证码模板；复用短信设置中的 AccessKey 和签名。",
    "",
    { maxLength: 64, pattern: "^$|^SMS_\\d{1,60}$" },
  ),
  setting(
    "notification.sms_daily_limit",
    "MINIAPP",
    "INTEGER",
    "每位员工每日短信上限",
    "按中国标准时间限制素材开放短信的每日发送次数，避免重复提醒和费用失控。",
    3,
    { min: 1, max: 50, unit: "条" },
  ),
  setting(
    "notification.wechat_template_id",
    "MINIAPP",
    "STRING",
    "新任务通知模板 ID",
    "在此小程序的微信后台添加订阅消息模板后，填写个人模板 ID。",
    "",
    {
      maxLength: 128,
      pattern: "^$|^[A-Za-z0-9_-]{1,128}$",
    },
  ),
  setting(
    "notification.wechat_template_fields",
    "MINIAPP",
    "STRING",
    "订阅模板字段映射",
    "按微信模板实际字段填写 JSON。文本可用 TASK_TITLE、ENTERPRISE_NAME、REMARK、TASK_TYPE、TASK_STATUS、TASK_PLATFORM；时间可用 VISIBLE_AT、EXPIRES_AT。当前预设对应“任务新增通知”72606 的五个已选字段。",
    '{"thing4":"TASK_TITLE","time5":"EXPIRES_AT","thing12":"TASK_TYPE","thing11":"REMARK","thing13":"TASK_PLATFORM"}',
    { maxLength: 2048 },
  ),
  setting(
    "notification.wechat_environment",
    "MINIAPP",
    "ENUM",
    "消息跳转小程序版本",
    "通知打开对应版本的任务详情；联调选开发版或体验版，正式发布后选正式版。",
    "formal",
    {
      options: [
        { label: "正式版", value: "formal" },
        { label: "体验版", value: "trial" },
        { label: "开发版", value: "developer" },
      ],
    },
  ),
  setting(
    "notification.retry_limit",
    "MINIAPP",
    "INTEGER",
    "通知重试次数",
    "通知服务明确返回临时失败时的最大重试次数；超时或发送结果不确定时不自动重发。",
    3,
    {
      max: 20,
      min: 0,
    },
  ),
  setting(
    "notification.quiet_hours_start",
    "MINIAPP",
    "STRING",
    "免打扰开始时间",
    "按中国标准时间使用 HH:mm 格式；开始与结束相同表示不启用免打扰。",
    "22:00",
    {
      pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
    },
  ),
  setting(
    "notification.quiet_hours_end",
    "MINIAPP",
    "STRING",
    "免打扰结束时间",
    "使用 HH:mm 格式。",
    "08:00",
    {
      pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
    },
  ),
] as const satisfies readonly PlatformSettingDefinition[];

export function platformSettingDefinition(key: string): PlatformSettingDefinition | undefined {
  return platformSettingCatalog.find((definition) => definition.key === key);
}

export function platformSettingGroupBySlug(slug: string) {
  return platformSettingGroups.find((group) => group.slug === slug);
}

function setting(
  key: string,
  group: PlatformSettingGroup,
  valueType: PlatformSettingValueType,
  label: string,
  description: string,
  defaultValue: PlatformSettingScalar,
  options: Partial<
    Omit<
      PlatformSettingDefinition,
      "defaultValue" | "description" | "group" | "key" | "label" | "store" | "valueType"
    >
  > = {},
): PlatformSettingDefinition {
  return {
    defaultValue,
    description,
    group,
    key,
    label,
    store: "PLATFORM_SETTING",
    valueType,
    ...options,
  };
}

function runtimeSetting(
  key: string,
  group: "GENERATION" | "RETRIEVAL",
  valueType: PlatformSettingValueType,
  label: string,
  description: string,
  runtimeField: RuntimePolicyField,
  defaultValue: PlatformSettingScalar,
  options: Partial<
    Omit<
      PlatformSettingDefinition,
      | "defaultValue"
      | "description"
      | "group"
      | "key"
      | "label"
      | "runtimeField"
      | "store"
      | "valueType"
    >
  > = {},
): PlatformSettingDefinition {
  return {
    defaultValue,
    description,
    group,
    key,
    label,
    runtimeField,
    store: "RUNTIME_POLICY",
    valueType,
    ...options,
  };
}
