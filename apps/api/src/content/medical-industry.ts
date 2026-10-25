export function isMedicalIndustry(industry: string | null | undefined) {
  return /医疗|医美|眼科|口腔|诊疗|医院|健康服务/u.test(industry ?? "");
}
