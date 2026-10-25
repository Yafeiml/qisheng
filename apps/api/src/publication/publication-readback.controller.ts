import { Body, Controller, Get, Headers, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { PublicationReadbackConfigurationService } from "../platform-settings/publication-readback.configuration";
// biome-ignore lint/style/useImportType: NestJS uses DTO runtime metadata for validation.
import {
  ReadbackClaimDto,
  ReadbackDailyLimitDto,
  ReadbackResultDto,
  ReadbackResumeDto,
  SaveReadbackConfigurationDto,
  TestReadbackConfigurationDto,
} from "./publication-readback.dto";
import { PublicationReadbackGuard } from "./publication-readback.guard";
import { PublicationReadbackService } from "./publication-readback.service";
import {
  ReadbackAdminOperationsResponseDto,
  ReadbackClaimResponseDto,
  ReadbackConfigurationResponseDto,
  ReadbackConfigurationTestResponseDto,
  ReadbackHealthResponseDto,
  ReadbackManagedClaimResponseDto,
  ReadbackOperationsResponseDto,
  ReadbackResultResponseDto,
  ReadbackStatusResponseDto,
} from "./publication-readback-response.dto";

@ApiTags("Publication Readback Collector")
@Controller("integrations/v1/publication-readback")
@UseGuards(PublicationReadbackGuard)
export class PublicationReadbackController {
  constructor(
    @Inject(PublicationReadbackService) private readonly readback: PublicationReadbackService,
  ) {}

  @Get("status")
  @ApiOkResponse({ type: ReadbackStatusResponseDto })
  status() {
    return this.readback.status();
  }

  @Get("operations")
  @ApiOkResponse({ type: ReadbackOperationsResponseDto })
  operations() {
    return this.readback.operations();
  }

  @Post("claim")
  @ApiCreatedResponse({ type: ReadbackClaimResponseDto })
  claim(@Headers("x-collector-id") nodeId: string, @Body() _body: ReadbackClaimDto) {
    return this.readback.claim(nodeId);
  }

  @Post("claim-managed")
  @ApiCreatedResponse({ type: ReadbackManagedClaimResponseDto })
  claimManaged(@Headers("x-collector-id") nodeId: string, @Body() _body: ReadbackClaimDto) {
    return this.readback.claimManaged(nodeId);
  }

  @Post(":id/result")
  @ApiCreatedResponse({ type: ReadbackResultResponseDto })
  result(
    @Headers("x-collector-id") nodeId: string,
    @Param("id") id: string,
    @Body() input: ReadbackResultDto,
  ) {
    return this.readback.result(nodeId, id, input);
  }
}

@Controller("platform/publication-readback")
@UseGuards(AdminAccessGuard)
export class PublicationReadbackAdminController {
  constructor(
    @Inject(PublicationReadbackService) private readonly readback: PublicationReadbackService,
    @Inject(PublicationReadbackConfigurationService)
    private readonly configuration: PublicationReadbackConfigurationService,
  ) {}

  @Get("configuration")
  @ApiOkResponse({ type: ReadbackConfigurationResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  configurationStatus() {
    return this.configuration.configuration();
  }

  @Post("configuration")
  @ApiCreatedResponse({ type: ReadbackConfigurationResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  saveConfiguration(@Body() input: SaveReadbackConfigurationDto) {
    return this.configuration.save(input);
  }

  @Post("test")
  @ApiCreatedResponse({ type: ReadbackConfigurationTestResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  testConfiguration(@Body() input: TestReadbackConfigurationDto) {
    return this.configuration.test(input.noteUrl, input.reason);
  }

  @Get("status")
  @ApiOkResponse({ type: ReadbackHealthResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  status() {
    return this.readback.health();
  }

  @Get("operations")
  @ApiOkResponse({ type: ReadbackAdminOperationsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  operations() {
    return this.readback.adminOperations();
  }

  @Post("daily-limit")
  @ApiCreatedResponse({ type: ReadbackAdminOperationsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  dailyLimit(@Body() input: ReadbackDailyLimitDto) {
    return this.readback.setDailyLimit(input.dailyLimit, input.reason);
  }

  @Post("resume")
  @ApiCreatedResponse({ type: ReadbackStatusResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  resume(@Body() input: ReadbackResumeDto) {
    return this.readback.resume(input.reason);
  }
}
