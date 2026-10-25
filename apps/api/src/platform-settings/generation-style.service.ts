import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  defaultGenerationStyles,
  type GenerationStyleConfiguration,
  type GenerationStylePreset,
  type GenerationStyleSnapshot,
  upgradeBuiltInGenerationStyles,
} from "@xhs-agentic/ai-gateway";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { SaveGenerationStylesDto } from "./generation-style.dto";

type StyleSelection = {
  contentDirectionPresetId?: string;
  imageStylePresetId?: string;
  contentDirection?: string;
  imageStyle?: string;
};

@Injectable()
export class GenerationStyleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
  ) {}

  async platformCurrent() {
    this.requirePlatform();
    return this.current();
  }

  async options() {
    const config = await this.current();
    const publicOptions = (presets: GenerationStylePreset[]) =>
      presets
        .filter((p) => p.enabled)
        .map(({ id, name, description, isDefault }) => ({ id, name, description, isDefault }));
    return {
      contentDirections: publicOptions(config.contentDirections),
      imageStyles: publicOptions(config.imageStyles),
    };
  }

  async save(input: SaveGenerationStylesDto) {
    const principal = this.requirePlatform();
    validatePresets(input.contentDirections, "内容方向");
    validatePresets(input.imageStyles, "图片风格");
    const ids = [...input.contentDirections, ...input.imageStyles].map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new ConflictException("预设 ID 不能重复");
    const configuration: GenerationStyleConfiguration = {
      copyBasePrompt: input.copyBasePrompt,
      imageBasePrompt: input.imageBasePrompt,
      contentDirections: input.contentDirections,
      imageStyles: input.imageStyles,
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const previous = await tx.generationStyleConfiguration.findUnique({
          where: { id: "platform" },
        });
        if ((previous?.version ?? 0) !== input.version) throw stale();
        const previousConfig =
          (previous?.configuration as GenerationStyleConfiguration | undefined) ??
          defaultGenerationStyles();
        for (const kind of ["contentDirections", "imageStyles"] as const) {
          if (
            previousConfig[kind].some((p) => !configuration[kind].some((next) => next.id === p.id))
          ) {
            throw new ConflictException("已有预设请停用，不能删除或更改 ID，以保留活动和模板引用");
          }
        }
        const data = {
          configuration: configuration as unknown as Prisma.InputJsonValue,
          updatedBy: principal.userId,
          version: input.version + 1,
        };
        if (previous) {
          const updated = await tx.generationStyleConfiguration.updateMany({
            where: { id: "platform", version: input.version },
            data,
          });
          if (updated.count !== 1) throw stale();
        } else {
          await tx.generationStyleConfiguration.create({ data: { id: "platform", ...data } });
        }
        await tx.auditLog.create({
          data: {
            action: "generation-style.configure",
            actorType: "USER",
            actorUserId: principal.userId,
            resourceType: "GenerationStyleConfiguration",
            resourceId: "platform",
            stateBefore: { version: input.version },
            stateAfter: { version: data.version, configuration: data.configuration },
          },
        });
        return { ...configuration, version: data.version };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw stale();
      throw error;
    }
  }

  async snapshot(selection?: StyleSelection): Promise<GenerationStyleSnapshot> {
    const config = await this.current();
    if (!selection) {
      return {
        schemaVersion: 1,
        configurationVersion: config.version,
        copyBasePrompt: config.copyBasePrompt,
        imageBasePrompt: config.imageBasePrompt,
        contentDirection: { id: "", name: "小红书分享", prompt: "" },
        imageStyle: { id: "", name: "小红书配图", prompt: "" },
      };
    }
    const pick = (
      presets: GenerationStylePreset[],
      id: string | undefined,
      legacyName: string | undefined,
      label: string,
    ) => {
      const selected = id
        ? presets.find((p) => p.id === id)
        : (presets.find((p) => p.enabled && p.name === legacyName) ??
          presets.find((p) => p.isDefault && p.enabled));
      if (!selected?.enabled) throw new ConflictException(`${label}预设已停用或不存在，请重新选择`);
      return { id: selected.id, name: selected.name, prompt: selected.prompt };
    };
    return {
      schemaVersion: 1,
      configurationVersion: config.version,
      copyBasePrompt: config.copyBasePrompt,
      imageBasePrompt: config.imageBasePrompt,
      contentDirection: pick(
        config.contentDirections,
        selection.contentDirectionPresetId,
        selection.contentDirection,
        "内容方向",
      ),
      imageStyle: pick(
        config.imageStyles,
        selection.imageStylePresetId,
        selection.imageStyle,
        "图片风格",
      ),
    };
  }

  private async current() {
    const row = await this.prisma.generationStyleConfiguration.findUnique({
      where: { id: "platform" },
    });
    const config = row
      ? upgradeBuiltInGenerationStyles(row.configuration as GenerationStyleConfiguration)
      : defaultGenerationStyles();
    return { ...config, version: row?.version ?? 0 };
  }

  private requirePlatform() {
    const principal = this.access.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM")
      throw new ForbiddenException("仅 SaaS 管理员可编辑生成风格");
    return principal;
  }
}

function validatePresets(presets: GenerationStylePreset[], label: string) {
  if (
    presets.filter((p) => p.isDefault).length !== 1 ||
    presets.some((p) => p.isDefault && !p.enabled)
  ) {
    throw new ConflictException(
      `${label}必须有且仅有一个已启用的默认预设；停用默认项前请先指定其他默认项`,
    );
  }
  if (new Set(presets.map((p) => p.name.trim().toLowerCase())).size !== presets.length) {
    throw new ConflictException(`${label}名称不能重复`);
  }
}

function stale() {
  return new ConflictException("配置已被其他管理员修改，请刷新后重新编辑");
}
