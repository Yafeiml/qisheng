import { isDeepStrictEqual } from "node:util";
import { ConflictException } from "@nestjs/common";
import { readMedicalPlan, readMedicalPublisherContext } from "@xhs-agentic/ai-gateway";
import { assertMedicalPublisherFits } from "./medical-planning.service";

export type MedicalTask = {
  membershipId: string;
  campaign: { selectionSnapshot?: unknown };
  membership?: { publisherContext: unknown };
  employeeContent: { revision: number };
  factsConfirmedAt?: Date | null;
  factsConfirmedRevision?: number | null;
  factsReturnedAt?: Date | null;
};

export function taskMedicalPlan(task: Pick<MedicalTask, "campaign" | "employeeContent">) {
  if (!task.campaign.selectionSnapshot) return undefined;
  try {
    const plan = readMedicalPlan(task.campaign.selectionSnapshot);
    if (!plan) throw new Error("Missing frozen plan");
    return plan;
  } catch {
    throw new ConflictException("该任务缺少有效的内容计划，请企业运营重新生成并审核。");
  }
}

export function assertTaskPublishingCurrent(task: MedicalTask, now = new Date()) {
  const plan = taskMedicalPlan(task);
  if (!plan) return;
  const frozen = plan.publishers.find(
    ({ membershipId }) => membershipId === task.membershipId,
  )?.publisherContext;
  if (!frozen || !task.membership)
    throw new ConflictException("发布安排待企业复核，请返回任务列表。");
  const current = assertMedicalPublisherFits(plan, task.membership.publisherContext, now);
  if (!isDeepStrictEqual(readMedicalPublisherContext(current), frozen))
    throw new ConflictException("企业发布安排已变化，请企业运营重新核验并审核内容。");
}

export function taskFactsConfirmed(task: MedicalTask) {
  return Boolean(
    task.factsConfirmedAt &&
      !task.factsReturnedAt &&
      task.factsConfirmedRevision === task.employeeContent.revision,
  );
}

export function assertTaskFactsConfirmed(task: MedicalTask, revision?: number) {
  if (revision !== task.employeeContent.revision)
    throw new ConflictException("内容已更新，请刷新后确认最新版本。");
  if (!taskFactsConfirmed(task))
    throw new ConflictException("请先确认本人事实与素材真实；如有问题，请退回企业复核。");
}

export function medicalPublicationIssue(
  task: MedicalTask,
  authorId?: string | null,
  manual = false,
): string | null {
  try {
    assertTaskPublishingCurrent(task);
    assertTaskFactsConfirmed(task, task.employeeContent.revision);
    if (!task.campaign.selectionSnapshot) return null;
    const plan = taskMedicalPlan(task);
    const expected = plan?.publishers.find(({ membershipId }) => membershipId === task.membershipId)
      ?.publisherContext.authorId;
    if (!authorId || !/^[A-Za-z0-9_-]{6,100}$/u.test(authorId))
      return "公开笔记缺少可核对的发布者身份，请企业人工复核。";
    if (expected && authorId !== expected)
      return "实际发布者与企业审核的发布安排不一致，请企业复核。";
    if (!expected && !manual) return "发布者归属尚未核实，请企业依据公开笔记进行人工复核。";
    return null;
  } catch (error) {
    if (error instanceof ConflictException) return error.message;
    throw error;
  }
}
