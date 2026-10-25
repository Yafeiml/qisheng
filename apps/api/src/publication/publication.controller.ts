import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { EmployeeAccessGuard } from "../access/employee-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  CreateDevelopmentPublicationDto,
  IngestPublicationMetricsDto,
  LateCorrectPublicationDto,
  PublicationReviewQueryDto,
  RetryPublicationVerificationDto,
  ReviewPublicationDto,
  SubmitPublicationDto,
} from "./publication.dto";
import { PublicationService } from "./publication.service";
import {
  DevelopmentPublicationResponseDto,
  PublicationReviewPageDto,
  PublicationSubmissionResultDto,
  PublishMetricSnapshotResponseDto,
  PublishSubmissionResponseDto,
} from "./publication-response.dto";

@Controller("employee/tasks")
@UseGuards(EmployeeAccessGuard)
export class PublicationEmployeeController {
  constructor(@Inject(PublicationService) private readonly publications: PublicationService) {}

  @Post(":taskId/dev-publication")
  @ApiCreatedResponse({ type: DevelopmentPublicationResponseDto })
  developmentPublication(
    @Param("taskId") taskId: string,
    @Body() input: CreateDevelopmentPublicationDto,
  ) {
    return this.publications.createDevelopmentPublication(taskId, input);
  }

  @Post(":taskId/submissions")
  @ApiCreatedResponse({ type: PublicationSubmissionResultDto })
  submit(@Param("taskId") taskId: string, @Body() input: SubmitPublicationDto) {
    return this.publications.submitEmployeePublication(taskId, input);
  }
}

@Controller()
@UseGuards(AdminAccessGuard)
export class PublicationAdminController {
  constructor(@Inject(PublicationService) private readonly publications: PublicationService) {}

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/publication-reviews")
  @ApiOkResponse({ type: PublicationReviewPageDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  list(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: PublicationReviewQueryDto,
  ) {
    return this.publications.listManualReviews({ enterpriseId, tenantId }, query);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/publication-reviews/:submissionId")
  @ApiCreatedResponse({ type: PublishSubmissionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  review(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("submissionId") submissionId: string,
    @Body() input: ReviewPublicationDto,
  ) {
    return this.publications.reviewManualSubmission(
      { enterpriseId, tenantId },
      submissionId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/tasks/:taskId/late-correction")
  @ApiCreatedResponse({ type: PublicationSubmissionResultDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  lateCorrect(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("taskId") taskId: string,
    @Body() input: LateCorrectPublicationDto,
  ) {
    return this.publications.lateCorrectPublication({ enterpriseId, tenantId }, taskId, input);
  }

  @Post(
    "console/tenants/:tenantId/enterprises/:enterpriseId/publication-reviews/:submissionId/retry",
  )
  @ApiCreatedResponse({ type: PublicationSubmissionResultDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  retry(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("submissionId") submissionId: string,
    @Body() input: RetryPublicationVerificationDto,
  ) {
    return this.publications.retryPublicationVerification(
      { enterpriseId, tenantId },
      submissionId,
      input.reason,
    );
  }
}

@Controller("integrations/v1")
export class PublicationIntegrationController {
  constructor(@Inject(PublicationService) private readonly publications: PublicationService) {}

  @Post("publish-metrics")
  @ApiCreatedResponse({ type: PublishMetricSnapshotResponseDto })
  ingest(
    @Headers("x-integration-signature") signature: string | undefined,
    @Headers("x-integration-timestamp") timestamp: string | undefined,
    @Body() input: IngestPublicationMetricsDto,
  ) {
    return this.publications.ingestMetrics(timestamp, signature, input);
  }
}
