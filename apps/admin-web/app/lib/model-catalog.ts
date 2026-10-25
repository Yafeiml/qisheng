import type { components } from "@xhs-agentic/contracts";

type Provider = components["schemas"]["ModelProviderResponseDto"];
type Model = components["schemas"]["ModelDefinitionResponseDto"];

// These exact name/code pairs are written by this repository's integration tests.
// Do not classify user connections merely because their names contain "test".
export function providerPurpose(
  provider: Pick<Provider, "code" | "name" | "synthetic" | "protocol">,
): "FORMAL" | "DEVELOPMENT" | "TEST" {
  if (
    (provider.name === "Sprint 6 Real Qualification Provider" &&
      /^S6_REAL_[A-F0-9]+$/u.test(provider.code)) ||
    (provider.name === "Sprint 6 Synthetic Provider" &&
      /^S6_SYNTH_[A-F0-9]+$/u.test(provider.code)) ||
    (/^REAL_[A-F0-9]+$/u.test(provider.code) &&
      provider.name === `Runtime Provider ${provider.code.slice(5)}`)
  )
    return "TEST";
  return provider.synthetic || provider.protocol === "SYNTHETIC" ? "DEVELOPMENT" : "FORMAL";
}

export function providerPurposeLabel(provider: Provider): string {
  return { FORMAL: "正式接入", DEVELOPMENT: "开发演示", TEST: "自动化测试遗留" }[
    providerPurpose(provider)
  ];
}

export function providerExplanation(provider: Provider): string {
  const kind = providerPurpose(provider);
  if (kind === "TEST")
    return provider.synthetic
      ? "自动化测试生成的模拟连接，用于验证流程。无需为它填写 API Key。"
      : "自动化测试创建的接口验证连接，不代表已接入可用于业务的真实模型服务。";
  if (kind === "DEVELOPMENT")
    return "本机演示生成器，用于体验操作流程，不调用真实 AI，也不需要 API Key。";
  return "保存调用模型所需的 API 地址和密钥。同一服务商可登记多个模型。";
}

export function modelCapabilityLabel(model: Pick<Model, "capabilities">): string {
  const capabilities = model.capabilities;
  const labels: string[] = [];
  if (capabilities.includes("MULTIMODAL")) labels.push("多模态");
  else if (capabilities.includes("TEXT") && capabilities.includes("VISION"))
    labels.push("文本与图片理解");
  else {
    if (capabilities.includes("TEXT")) labels.push("文案生成");
    if (capabilities.includes("VISION")) labels.push("图片理解");
  }
  if (capabilities.includes("IMAGE")) labels.push("图片生成");
  if (capabilities.includes("EMBEDDING")) labels.push("检索向量");
  return labels.join("、") || "未声明能力";
}
