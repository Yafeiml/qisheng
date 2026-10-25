import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { defaultGenerationStyles } from "@xhs-agentic/ai-gateway";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { afterAll, describe, expect, it } from "vitest";
import { RequestAccessContext } from "../access/request-access-context";
import { CreateCampaignDto } from "../campaign/campaign.dto";
import type { PrismaService } from "../database/prisma.service";
import { SaveGenerationStylesDto } from "./generation-style.dto";
import { GenerationStyleService } from "./generation-style.service";

const prisma = new PrismaClient();
const rollback = new Error("ROLLBACK_STYLE_TEST");
afterAll(() => prisma.$disconnect());

async function isolated(
  run: (service: GenerationStyleService, tx: Prisma.TransactionClient) => Promise<void>,
) {
  if (!process.env.DATABASE_URL?.includes("dev_")) throw new Error("Requires development database");
  try {
    await prisma.$transaction(
      async (tx) => {
        // All edits, including this reset, roll back and are never visible to other sessions.
        await tx.generationStyleConfiguration.deleteMany({});
        const admin = await tx.adminUser.create({
          data: { phone: `style-${randomUUID().slice(0, 16)}` },
        });
        const access = new RequestAccessContext();
        access.initialize({
          audience: "SAAS_ADMIN",
          userId: admin.id,
          scope: { type: "PLATFORM" },
          permissions: ["platform.settings.manage"],
        });
        const db = new Proxy(tx, {
          get(target, key) {
            return key === "$transaction"
              ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
              : Reflect.get(target, key);
          },
        }) as unknown as PrismaService;
        await run(new GenerationStyleService(db, access), tx);
        throw rollback;
      },
      { timeout: 15_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("platform generation style configuration", () => {
  it("persists edits, ordering, defaults and audit while old snapshots stay unchanged", async () => {
    await isolated(async (service, tx) => {
      const initial = await service.platformCurrent();
      const frozen = await service.snapshot({});
      expect(frozen.imageStyle.name).toBe("真实场景摄影");
      const configuration = structuredClone(initial);
      configuration.copyBasePrompt = "更新后的文案基础要求，使用清晰自然的表达。";
      requiredFixture(configuration.contentDirections[0]).prompt = "编辑后的专业科普生成要求。";
      configuration.imageStyles.forEach((p) => {
        p.isDefault = false;
      });
      configuration.imageStyles.unshift({
        id: "custom-photo",
        name: "暖调摄影",
        description: "温暖柔和的摄影",
        prompt: "自然的暖调摄影，保持真实材质和柔和光影。",
        enabled: true,
        isDefault: true,
      });
      const saved = await service.save(configuration);
      expect(saved.version).toBe(1);
      const current = await service.snapshot({});
      expect(current.imageStyle.id).toBe("custom-photo");
      expect(current.copyBasePrompt).toContain("更新后");
      expect(frozen.imageStyle.id).toBe("image-documentary");
      expect(frozen.copyBasePrompt).not.toContain("更新后");
      expect((await service.platformCurrent()).imageStyles[0]?.id).toBe("custom-photo");
      expect(
        await tx.auditLog.count({ where: { action: "generation-style.configure" } }),
      ).toBeGreaterThan(0);
      await expect(service.save(initial)).rejects.toThrow("其他管理员修改");
    });
  });

  it("filters disabled choices and never exposes prompts through enterprise options", async () => {
    await isolated(async (service) => {
      const input = await service.platformCurrent();
      const frozen = await service.snapshot({ imageStylePresetId: "image-minimal" });
      requiredFixture(input.imageStyles.find((p) => p.id === "image-minimal")).enabled = false;
      await service.save(input);
      const options = await service.options();
      expect(options.imageStyles.some((p) => p.id === "image-minimal")).toBe(false);
      expect(Object.keys(requiredFixture(options.imageStyles[0]))).toEqual([
        "id",
        "name",
        "description",
        "isDefault",
      ]);
      expect(JSON.stringify(options)).not.toContain("prompt");
      await expect(service.snapshot({ imageStylePresetId: "image-minimal" })).rejects.toThrow(
        "停用",
      );
      await expect(service.snapshot({ contentDirectionPresetId: "forged" })).rejects.toThrow(
        "不存在",
      );
      expect(frozen.imageStyle.prompt).toContain("静物摄影");
    });
  });

  it("rejects ambiguous defaults, duplicate names and deletion of referenced identities", async () => {
    await isolated(async (service) => {
      const initial = await service.platformCurrent();
      const disabledDefault = structuredClone(initial);
      requiredFixture(disabledDefault.contentDirections[0]).enabled = false;
      await expect(service.save(disabledDefault)).rejects.toThrow("默认预设");
      const duplicate = structuredClone(initial);
      requiredFixture(duplicate.contentDirections[1]).name = requiredFixture(
        duplicate.contentDirections[0],
      ).name;
      await expect(service.save(duplicate)).rejects.toThrow("名称不能重复");
      const deleted = structuredClone(initial);
      deleted.imageStyles.pop();
      await expect(service.save(deleted)).rejects.toThrow("不能删除");
      expect((await service.platformCurrent()).version).toBe(0);
    });
  });

  it("accepts legacy labels and defaults without rewriting supplied activity facts", async () => {
    await isolated(async (service) => {
      const selected = await service.snapshot({
        contentDirection: "常见问题解答",
        imageStyle: "简约静物摄影",
      });
      expect(selected.contentDirection.id).toBe("direction-questions");
      expect(selected.imageStyle.id).toBe("image-minimal");
      const automatic = await service.snapshot({ contentDirection: "历史自定义分类" });
      expect(automatic.contentDirection.id).toBe("direction-education");
    });
  });

  it("rejects enterprise administration access to editable platform prompts", async () => {
    const access = new RequestAccessContext();
    access.initialize({
      audience: "SAAS_ADMIN",
      userId: "enterprise-admin",
      permissions: [],
      scope: { type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "enterprise" },
    });
    const service = new GenerationStyleService({} as PrismaService, access);
    await expect(service.platformCurrent()).rejects.toThrow("仅 SaaS 管理员");
    await expect(service.save({ ...defaultGenerationStyles(), version: 0 })).rejects.toThrow(
      "仅 SaaS 管理员",
    );
  });

  it("validates nested payloads and excludes runtime style snapshots from user input", async () => {
    const valid = { ...defaultGenerationStyles(), version: 0 };
    expect(await validate(plainToInstance(SaveGenerationStylesDto, valid))).toEqual([]);
    const invalid = structuredClone(valid);
    requiredFixture(invalid.imageStyles[0]).prompt = "";
    expect(await validate(plainToInstance(SaveGenerationStylesDto, invalid))).not.toEqual([]);
    const forged = plainToInstance(CreateCampaignDto, {
      title: "合法活动",
      prompt: "介绍项目特点",
      generationStyleSnapshot: { copyBasePrompt: "企业自行覆盖平台规则" },
    });
    const errors = await validate(forged, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((error) => error.property === "generationStyleSnapshot")).toBe(true);
  });
});

function requiredFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
