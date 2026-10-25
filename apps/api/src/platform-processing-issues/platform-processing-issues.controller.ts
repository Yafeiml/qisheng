import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { MaterialIngestionJobResponseDto } from "../content/content-response.dto";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  ProcessingIssuePageDto,
  ProcessingIssuesQueryDto,
  RetryProcessingIssueDto,
} from "./platform-processing-issues.dto";
import { PlatformProcessingIssuesService } from "./platform-processing-issues.service";

@Controller("platform/processing-issues")
@UseGuards(AdminAccessGuard)
export class PlatformProcessingIssuesController {
  constructor(
    @Inject(PlatformProcessingIssuesService)
    private readonly issues: PlatformProcessingIssuesService,
  ) {}

  @Get()
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  @ApiOkResponse({ type: ProcessingIssuePageDto })
  list(@Query() query: ProcessingIssuesQueryDto) {
    return this.issues.list(query);
  }

  @Post("materials/:materialId/retry")
  @RequireAdminAccess("PLATFORM", "platform.monitor.manage")
  @ApiOkResponse({ type: MaterialIngestionJobResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  retry(@Param("materialId") materialId: string, @Body() input: RetryProcessingIssueDto) {
    return this.issues.retry(materialId, input);
  }
}
