import { createHash } from "node:crypto";
import type { MedicalPlan } from "@xhs-agentic/ai-gateway";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  medicalQuestionCardPageCount,
  renderMedicalOriginal,
  renderMedicalQuestionCard,
} from "./medical-images";

const plan: MedicalPlan = {
  schemaVersion: "medical-selection-v1",
  executionVersion: "medical-plan-v1",
  objective: "GEO_AND_TRANSACTION",
  priority: "BALANCED",
  topicIds: ["q"],
  readerSituation: "FIRST_UNDERSTANDING",
  noteForm: "QUESTION_LIST",
  imageMode: "QUESTION_CARD",
  conversionPath: "NONE",
  topics: [
    {
      id: "q",
      seriesId: "s",
      version: 1,
      question: "<script>& 第一次了解要准备什么？",
      intent: "",
      entityId: "",
      entityName: "",
    },
  ],
  publishers: [
    {
      membershipId: "m",
      publisherContext: {
        schemaVersion: "medical-publisher-v1",
        category: "ORDINARY",
        allowBrandAttribution: false,
        allowPlatformConsultation: false,
      },
    },
  ],
  frozenAt: "2026-10-13T08:00:00Z",
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("medical photos and question cards", () => {
  it("requires authorization and privacy confirmation before using an original photo", async () => {
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: "#345678" },
    })
      .png()
      .toBuffer();
    await expect(
      renderMedicalOriginal([{ bytes, authorizationConfirmed: true }], 1),
    ).rejects.toMatchObject({ code: "MEDICAL_ORIGINAL_NOT_CONFIRMED" });
    const assets = [{ bytes, authorizationConfirmed: true, privacyConfirmed: true }];
    const first = await renderMedicalOriginal(assets, 1, 108, 144);
    expect(await sharp(first).metadata()).toMatchObject({ width: 108, height: 144 });
    expect(digest(await renderMedicalOriginal(assets, 1, 108, 144))).toBe(digest(first));
    // Original evidence is not perturbed to pretend each member has a different photograph.
    expect(digest(await renderMedicalOriginal(assets, 2, 108, 144))).toBe(digest(first));
  });

  it("renders escaped text and distinct page tasks locally without creating a fake clinical image", async () => {
    const copy = {
      title: "一个准备问题",
      body: "<svg onload='alert(1)'>不是指令 & 不是照片\n先确认适用条件。\n准备事项必须按实际情况核对。",
    };
    const cover = await renderMedicalQuestionCard(plan, copy, 1, 108, 144);
    const checklist = await renderMedicalQuestionCard(plan, copy, 2, 108, 144);
    expect(await sharp(cover).metadata()).toMatchObject({ format: "png", width: 108, height: 144 });
    expect(digest(cover)).not.toBe(digest(checklist));
    expect(digest(await renderMedicalQuestionCard(plan, copy, 1, 108, 144))).toBe(digest(cover));
    expect(medicalQuestionCardPageCount(copy)).toBe(2);
    expect(medicalQuestionCardPageCount({ body: "单个完整段落" })).toBe(1);
  });

  it("combines multiple authorized photos without cropping their contents", async () => {
    const photo = async (background: string) => ({
      bytes: await sharp({ create: { width: 80, height: 60, channels: 3, background } })
        .png()
        .toBuffer(),
      authorizationConfirmed: true,
      privacyConfirmed: true,
    });
    const assets = [await photo("#ff0000"), await photo("#0000ff")];
    const collage = await renderMedicalOriginal(assets, 1, 108, 144);
    const left = await sharp(collage)
      .extract({ left: 20, top: 60, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const right = await sharp(collage)
      .extract({ left: 80, top: 60, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect([...left]).toEqual([255, 0, 0]);
    expect([...right]).toEqual([0, 0, 255]);
    expect(digest(collage)).not.toBe(digest(await renderMedicalOriginal(assets, 2, 108, 144)));
  });
});
