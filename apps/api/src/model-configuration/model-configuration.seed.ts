import type { PrismaClient } from "@xhs-agentic/database";

export async function seedDevelopmentModelRoute(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const provider = await prisma.modelProvider.upsert({
    create: {
      baseUrl: "synthetic://local",
      code: "DEV_SYNTHETIC",
      name: "本机开发生成器",
      protocol: "SYNTHETIC",
      synthetic: true,
    },
    update: {
      baseUrl: "synthetic://local",
      name: "本机开发生成器",
      protocol: "SYNTHETIC",
      status: "ACTIVE",
      synthetic: true,
    },
    where: { code: "DEV_SYNTHETIC" },
  });
  const textModel = await prisma.modelDefinition.upsert({
    create: {
      capabilities: ["TEXT"],
      code: "SYNTHETIC_COPY_V1",
      displayName: "开发文案生成器 V1",
      externalModelId: "synthetic-copy-v1",
      providerId: provider.id,
      synthetic: true,
    },
    update: { capabilities: ["TEXT"], status: "ACTIVE", synthetic: true },
    where: { providerId_code: { code: "SYNTHETIC_COPY_V1", providerId: provider.id } },
  });
  const imageModel = await prisma.modelDefinition.upsert({
    create: {
      capabilities: ["IMAGE"],
      code: "SYNTHETIC_SVG_V1",
      displayName: "开发独立 SVG 生成器 V1",
      externalModelId: "synthetic-svg-v1",
      providerId: provider.id,
      synthetic: true,
    },
    update: { capabilities: ["IMAGE"], status: "ACTIVE", synthetic: true },
    where: { providerId_code: { code: "SYNTHETIC_SVG_V1", providerId: provider.id } },
  });
  const creator = await prisma.adminUser.findUnique({
    select: { id: true },
    where: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE ?? "13800000000" },
  });
  if (!creator) throw new Error("Development platform administrator must be seeded first");
  await prisma.modelRoute.upsert({
    create: {
      createdBy: creator.id,
      imageModelId: imageModel.id,
      scopeId: "platform",
      scopeType: "PLATFORM",
      textModelId: textModel.id,
    },
    update: { imageModelId: imageModel.id, textModelId: textModel.id },
    where: { scopeType_scopeId: { scopeId: "platform", scopeType: "PLATFORM" } },
  });
}
