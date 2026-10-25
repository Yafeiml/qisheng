import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: Nest requires DTO classes at runtime.
import { GenerationStylesResponseDto, SaveGenerationStylesDto } from "./generation-style.dto";
import { GenerationStyleService } from "./generation-style.service";

@ApiTags("Platform Settings")
@Controller("platform/generation-styles")
@UseGuards(AdminAccessGuard)
export class GenerationStyleController {
  constructor(@Inject(GenerationStyleService) private readonly styles: GenerationStyleService) {}

  @Get()
  @ApiOkResponse({ type: GenerationStylesResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  current() {
    return this.styles.platformCurrent();
  }

  @Post()
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: GenerationStylesResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  save(@Body() input: SaveGenerationStylesDto) {
    return this.styles.save(input);
  }
}
