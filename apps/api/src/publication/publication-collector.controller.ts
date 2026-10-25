import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: NestJS requires concrete request DTOs for ValidationPipe metadata.
import {
  ClaimCollectionJobDto,
  CollectionEvidenceDto,
  CollectionLeaseDto,
  PauseCollectionDto,
  ResumeCollectionDto,
} from "./publication-collector.dto";
import { PublicationCollectorGuard } from "./publication-collector.guard";
import { PublicationCollectorService } from "./publication-collector.service";
import {
  PublicationCollectionClaimResponseDto,
  PublicationCollectionEvidenceResponseDto,
  PublicationCollectionLeaseResponseDto,
  PublicationCollectorPausedResponseDto,
  PublicationCollectorResumedResponseDto,
  PublicationCollectorStatusResponseDto,
} from "./publication-collector-response.dto";

@ApiTags("Publication Browser Collector")
@Controller("integrations/v2/collection-jobs")
@UseGuards(PublicationCollectorGuard)
export class PublicationCollectorController {
  constructor(
    @Inject(PublicationCollectorService) private readonly jobs: PublicationCollectorService,
  ) {}

  @Get("status")
  @ApiOkResponse({ type: PublicationCollectorStatusResponseDto })
  status() {
    return this.jobs.status();
  }

  @Post("claim")
  @ApiCreatedResponse({ type: PublicationCollectionClaimResponseDto })
  claim(@Body() _input: ClaimCollectionJobDto) {
    return this.jobs.claim();
  }

  @Post("pause")
  @ApiCreatedResponse({ type: PublicationCollectorPausedResponseDto })
  pause(@Body() input: PauseCollectionDto) {
    return this.jobs.pause(input.reason);
  }

  @Post(":id/heartbeat")
  @ApiCreatedResponse({ type: PublicationCollectionLeaseResponseDto })
  heartbeat(@Param("id") id: string, @Body() input: CollectionLeaseDto) {
    return this.jobs.heartbeat(id, input.leaseToken);
  }

  @Post(":id/evidence")
  @ApiCreatedResponse({ type: PublicationCollectionEvidenceResponseDto })
  evidence(@Param("id") id: string, @Body() input: CollectionEvidenceDto) {
    return this.jobs.evidence(id, input);
  }
}

@Controller("platform/publication-collector")
@UseGuards(AdminAccessGuard)
export class PublicationCollectorAdminController {
  constructor(
    @Inject(PublicationCollectorService) private readonly jobs: PublicationCollectorService,
  ) {}

  @Get("status")
  @ApiOkResponse({ type: PublicationCollectorStatusResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  status() {
    return this.jobs.status();
  }

  @Post("resume")
  @ApiCreatedResponse({ type: PublicationCollectorResumedResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  resume(@Body() input: ResumeCollectionDto) {
    return this.jobs.resume(input.reason);
  }
}
