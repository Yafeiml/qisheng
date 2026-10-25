import type { ContentSafetyCategory, ContentSafetyScanResult, ContentSafetyText } from "./types";

const medicalService =
  /全飞秒?|半飞秒?|屈光|近视手术|激光手术|人工晶体|植入晶体|医疗器械|医美|整形|眼科/u;
const medicalBrand =
  /蔡司|ZEISS|VISUMAX|爱尔康|ALCON|强生|博士伦|STAAR|鹰视|WAVELIGHT|AMARIS|SCHWIND/iu;
const institution = /[\p{Script=Han}A-Z0-9]{2,30}(?:医院|眼科|诊所|医疗美容|屈光手术中心)/iu;
const devicePromotion = /(?<!未|没有|并不|不曾|从未|未曾)(?:配备|引进|采用|搭载|拥有|配置|选用)/u;
const manufacturerBacking = /认证|授权|卓越奖/u;
const doctor = /医生|医师|院长|主任|专家/u;
const brandBackedDoctor = new RegExp(
  `(?:${medicalBrand.source}).{0,40}(?:${manufacturerBacking.source}).{0,40}(?:${doctor.source})|(?:${doctor.source}).{0,40}(?:获|取得|拥有).{0,20}(?:${medicalBrand.source}).{0,40}(?:${manufacturerBacking.source})`,
  "iu",
);
// Remove only denied credential claims, so an unrelated denial cannot erase a positive endorsement.
const negatedDoctorBacking = new RegExp(
  `(?:不是|并非|未获|未取得|没有(?:获得|取得)?)\\s*(?:德国)?(?:${medicalBrand.source})(?:(?!(?:${medicalBrand.source})).){0,40}?(?:${manufacturerBacking.source})|(?:${medicalBrand.source})(?:(?!(?:${medicalBrand.source})).){0,15}?(?:没有|并未|未经|未)(?:官方)?(?:认证|授权)`,
  "giu",
);
const recommendation =
  /推荐|首选|优选|选择我们|来院|到院|预约|探店|专家护航|更安心|放心做|选对专家/u;
const educationalNegation =
  /^(?:.{0,12}(?:科普|提醒)[：:]?)?(?:不要|不应|不能|不得|切勿|避免|警惕)(?:仅凭|只凭|只因|因为|相信|根据|以|把|将|宣传|推荐|用)/u;

export function medicalPromotionCategories(
  text: ContentSafetyText,
): readonly ContentSafetyCategory[] {
  const sentences = [text.title, text.body, ...text.hashtags]
    .join("\n")
    .normalize("NFKC")
    .split(/[。\n!?！？;；,，]/u)
    .map((sentence) => sentence.trim());
  let decision: "BLOCK" | "REVIEW" | undefined;
  for (const sentence of sentences) {
    if (!medicalService.test(sentence) || educationalNegation.test(sentence)) continue;
    // shortcut: this floor covers known device brands; expand it when a new missed promotion is confirmed.
    if (
      medicalBrand.test(sentence) &&
      ((institution.test(sentence) && devicePromotion.test(sentence)) ||
        brandBackedDoctor.test(sentence.replace(negatedDoctorBacking, "")))
    ) {
      decision = "BLOCK";
      break;
    }
    if (institution.test(sentence) && recommendation.test(sentence)) decision = "REVIEW";
  }
  return decision
    ? [
        {
          code: "XHS_MEDICAL_PROMOTION",
          decision,
          message:
            decision === "BLOCK"
              ? "含医疗机构与器械品牌推广或医生厂商认证背书；事实真实也不能作为员工笔记推广依据，请删除该推广与背书表达，由企业核对真实问题和事实来源。"
              : "含具体医疗机构的服务推荐，无法确认适用发布条件，请删除推广和背书表达，由企业核对真实问题、事实来源及发布条件。",
        },
      ]
    : [];
}

export function applyXhsMedicalPromotionPolicy(
  text: ContentSafetyText,
  result: ContentSafetyScanResult,
): ContentSafetyScanResult {
  const categories = [...result.categories, ...medicalPromotionCategories(text)];
  const severity = { PASS: 0, REVIEW: 1, BLOCK: 2 } as const;
  const decision = categories.reduce(
    (current, category) =>
      severity[category.decision] > severity[current] ? category.decision : current,
    result.decision,
  );
  return { ...result, categories, decision };
}
