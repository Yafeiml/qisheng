import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: Nest validation needs runtime DTO classes.
import {
  LabCheckDto,
  LabExecuteDto,
  LabPromoteDto,
  LabRunResponseDto,
  LabUploadDto,
} from "./generation-lab.dto";
import { GenerationLabService } from "./generation-lab.service";

@Controller("platform/generation-lab")
@UseGuards(AdminAccessGuard)
@RequireAdminAccess("PLATFORM", "platform.model.manage")
export class GenerationLabController {
  constructor(@Inject(GenerationLabService) private readonly lab: GenerationLabService) {}
  @Get("options")
  @ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
  options(@Query("search") search?: string) {
    return this.lab.options(search);
  }
  @Get("medical-options")
  @ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
  medicalOptions(@Query("enterpriseId") enterpriseId: string) {
    return this.lab.medicalOptions(enterpriseId);
  }
  @Get()
  @ApiOkResponse({
    schema: { type: "array", items: { type: "object", additionalProperties: true } },
  })
  list(@Query("cursor") cursor?: string) {
    return this.lab.list(cursor);
  }
  @Post("check")
  @Idempotent()
  @ApiCreatedResponse({ type: LabRunResponseDto })
  check(@Body() input: LabCheckDto) {
    return this.lab.check(input);
  }
  @Get(":id")
  @ApiOkResponse({ type: LabRunResponseDto })
  get(@Param("id") id: string) {
    return this.lab.get(id);
  }
  @Post(":id/fork")
  @Idempotent()
  @ApiCreatedResponse({ type: LabRunResponseDto })
  fork(@Param("id") id: string) {
    return this.lab.fork(id);
  }
  @Post(":id/execute")
  @Idempotent()
  @ApiCreatedResponse({ type: LabRunResponseDto })
  execute(@Param("id") id: string, @Body() input: LabExecuteDto) {
    return this.lab.execute(id, input);
  }
  @Post(":id/review")
  @Idempotent()
  @ApiCreatedResponse({ type: LabRunResponseDto })
  review(@Param("id") id: string) {
    return this.lab.review(id);
  }
  @Post(":id/promote")
  @Idempotent()
  @ApiCreatedResponse({ schema: { type: "object", additionalProperties: true } })
  promote(@Param("id") id: string, @Body() input: LabPromoteDto) {
    return this.lab.promote(id, input);
  }
  @Post(":id/assets")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 1, fieldSize: 4000, parts: 2 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "description"],
      properties: { file: { type: "string", format: "binary" }, description: { type: "string" } },
    },
  })
  @ApiCreatedResponse({ type: LabRunResponseDto })
  upload(
    @Param("id") id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() input: LabUploadDto,
  ) {
    return this.lab.upload(id, file, input.description);
  }
  @Delete(":id/assets/:assetId")
  @ApiOkResponse({ type: LabRunResponseDto })
  removeAsset(@Param("id") id: string, @Param("assetId") assetId: string) {
    return this.lab.removeAsset(id, assetId);
  }
  @Get(":id/images/:assetId")
  @Header("Cache-Control", "private, no-store")
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  async image(@Param("id") id: string, @Param("assetId") assetId: string) {
    return new StreamableFile(await this.lab.image(id, assetId), { type: "image/png" });
  }
  @Post(":id/archive")
  @Idempotent()
  @ApiCreatedResponse({ schema: { type: "object", properties: { archived: { type: "boolean" } } } })
  archive(@Param("id") id: string) {
    return this.lab.archive(id);
  }
}
