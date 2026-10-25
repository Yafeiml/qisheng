import { generationDeliveryMode } from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";

export function modelIncidentCustomerMessage(status: string): string {
  const problem = "生成服务连续多轮重试仍未恢复，已暂停新的生成任务。";
  if (status === "SENT") return `${problem}已通知平台管理员处理，请稍后再试。`;
  if (["PENDING", "SENDING", "FAILED"].includes(status))
    return `${problem}问题已记录，正在通知平台管理员处理。`;
  return `${problem}问题已记录，但管理员邮件暂未送达，请联系平台支持。`;
}

export async function routeNotificationStatus(
  client: Pick<Prisma.TransactionClient, "modelRouteIncident">,
  routeId: string,
  fingerprint: string,
  qualificationId?: string,
) {
  const incident = await client.modelRouteIncident.findFirst({
    where: {
      routeId,
      configurationFingerprint: fingerprint,
      qualificationId,
      deliveryMode: generationDeliveryMode(),
      status: "OPEN",
    },
    select: { notificationStatus: true },
  });
  return incident?.notificationStatus ?? null;
}
