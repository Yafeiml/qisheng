import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  BulkCreateTextMaterialsDto,
  CompleteMaterialUploadDto,
  CreateGeoEntityDto,
  CreateGeoTopicDto,
  CreateMaterialDto,
  CreateMaterialLinkDto,
  CreateMaterialRevisionDto,
  CreateMaterialUploadIntentDto,
  CreateSensitiveRuleDto,
  DisableContentDto,
  ImportSensitiveRulesCsvDto,
  PublishGeoEntityVersionDto,
  PublishGeoTopicVersionDto,
  PublishMaterialVersionDto,
  PublishSensitiveRuleVersionDto,
  RetryMaterialIngestionDto,
  SupplementMaterialDto,
} from "./content.dto";
import { ContentService } from "./content.service";
import {
  BulkMaterialReportResponseDto,
  FocusRecommendationDto,
  GeoEntityResponseDto,
  GeoEntityWithTopicsDto,
  GeoTopicResponseDto,
  MaterialArtifactPreviewResponseDto,
  MaterialIngestionJobResponseDto,
  MaterialIngestionQueuedResponseDto,
  MaterialOptionsResponseDto,
  MaterialResponseDto,
  MaterialRevisionResponseDto,
  MaterialSupplementQueuedResponseDto,
  MaterialUploadIntentResponseDto,
  SensitiveRuleImportReportResponseDto,
  SensitiveRuleResponseDto,
} from "./content-response.dto";
import { MaterialIngestionService } from "./material-ingestion.service";

@Controller()
@UseGuards(AdminAccessGuard)
export class ContentController {
  constructor(
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(MaterialIngestionService) private readonly ingestion: MaterialIngestionService,
  ) {}

  @Post("console/tenants/:tenantId/materials/:materialId/supplement")
  @ApiCreatedResponse({ type: MaterialSupplementQueuedResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  supplementTenantMaterial(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: SupplementMaterialDto,
  ) {
    return this.ingestion.supplement(tenantScope(tenantId), materialId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/supplement")
  @ApiCreatedResponse({ type: MaterialSupplementQueuedResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  supplementEnterpriseMaterial(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: SupplementMaterialDto,
  ) {
    return this.ingestion.supplement(enterpriseScope(tenantId, enterpriseId), materialId, input);
  }

  @Get("console/tenants/:tenantId/materials")
  @ApiOkResponse({ type: [MaterialResponseDto] })
  @RequireAdminAccess("TENANT", "material.read")
  listTenantMaterials(@Param("tenantId") tenantId: string) {
    return this.content.listMaterials(tenantScope(tenantId));
  }

  @Post("console/tenants/:tenantId/materials")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  createTenantMaterial(@Param("tenantId") tenantId: string, @Body() input: CreateMaterialDto) {
    return this.content.createMaterial(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/materials/bulk-text")
  @ApiCreatedResponse({ type: BulkMaterialReportResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  bulkCreateTenantMaterials(
    @Param("tenantId") tenantId: string,
    @Body() input: BulkCreateTextMaterialsDto,
  ) {
    return this.content.bulkCreateTextMaterials(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/material-upload-intents")
  @ApiCreatedResponse({ type: MaterialUploadIntentResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  createTenantMaterialUploadIntent(
    @Param("tenantId") tenantId: string,
    @Body() input: CreateMaterialUploadIntentDto,
  ) {
    return this.ingestion.createUploadIntent(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/revision")
  @ApiCreatedResponse({ type: MaterialRevisionResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  createTenantMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: CreateMaterialRevisionDto,
  ) {
    return this.ingestion.createRevision(tenantScope(tenantId), materialId, input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/revision/resume")
  @ApiCreatedResponse({ type: MaterialRevisionResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  resumeTenantMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: CreateMaterialRevisionDto,
  ) {
    return this.ingestion.resumeRevision(tenantScope(tenantId), materialId, input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/revision/finalize")
  @ApiCreatedResponse({ type: MaterialSupplementQueuedResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  finalizeTenantMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
  ) {
    return this.ingestion.finalizeRevision(tenantScope(tenantId), materialId);
  }

  @Post("console/tenants/:tenantId/material-links")
  @ApiCreatedResponse({ type: MaterialIngestionQueuedResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  createTenantMaterialLink(
    @Param("tenantId") tenantId: string,
    @Body() input: CreateMaterialLinkDto,
  ) {
    return this.ingestion.createLink(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/artifacts/:artifactId/complete")
  @ApiCreatedResponse({ type: MaterialIngestionQueuedResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  completeTenantMaterialUpload(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Param("artifactId") artifactId: string,
    @Body() input: CompleteMaterialUploadDto,
  ) {
    return this.ingestion.completeUpload(tenantScope(tenantId), materialId, artifactId, input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/ingestion/retry")
  @ApiCreatedResponse({ type: MaterialIngestionJobResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  retryTenantMaterialIngestion(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: RetryMaterialIngestionDto,
  ) {
    return this.ingestion.retry(tenantScope(tenantId), materialId, input);
  }

  @Get("console/tenants/:tenantId/materials/:materialId/artifacts/:artifactId/preview")
  @ApiOkResponse({ type: MaterialArtifactPreviewResponseDto })
  @RequireAdminAccess("TENANT", "material.read")
  previewTenantMaterialArtifact(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Param("artifactId") artifactId: string,
  ) {
    return this.ingestion.previewArtifact(tenantScope(tenantId), materialId, artifactId);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/versions")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  publishTenantMaterialVersion(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: PublishMaterialVersionDto,
  ) {
    return this.content.publishMaterialVersion(tenantScope(tenantId), materialId, input);
  }

  @Post("console/tenants/:tenantId/materials/:materialId/disable")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  disableTenantMaterial(
    @Param("tenantId") tenantId: string,
    @Param("materialId") materialId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableMaterial(tenantScope(tenantId), materialId, input);
  }

  @Get("console/tenants/:tenantId/sensitive-rules")
  @ApiOkResponse({ type: [SensitiveRuleResponseDto] })
  @RequireAdminAccess("TENANT", "material.read")
  listTenantSensitiveRules(@Param("tenantId") tenantId: string) {
    return this.content.listSensitiveRules(tenantScope(tenantId));
  }

  @Post("console/tenants/:tenantId/sensitive-rules/import-csv")
  @ApiCreatedResponse({ type: SensitiveRuleImportReportResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  importTenantSensitiveRulesCsv(
    @Param("tenantId") tenantId: string,
    @Body() input: ImportSensitiveRulesCsvDto,
  ) {
    return this.content.importSensitiveRulesCsv(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/sensitive-rules")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  createTenantSensitiveRule(
    @Param("tenantId") tenantId: string,
    @Body() input: CreateSensitiveRuleDto,
  ) {
    return this.content.createSensitiveRule(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/sensitive-rules/:ruleId/versions")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  publishTenantSensitiveRuleVersion(
    @Param("tenantId") tenantId: string,
    @Param("ruleId") ruleId: string,
    @Body() input: PublishSensitiveRuleVersionDto,
  ) {
    return this.content.publishSensitiveRuleVersion(tenantScope(tenantId), ruleId, input);
  }

  @Post("console/tenants/:tenantId/sensitive-rules/:ruleId/disable")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "material.manage")
  disableTenantSensitiveRule(
    @Param("tenantId") tenantId: string,
    @Param("ruleId") ruleId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableSensitiveRule(tenantScope(tenantId), ruleId, input);
  }

  @Get("console/tenants/:tenantId/geo-entities")
  @ApiOkResponse({ type: [GeoEntityWithTopicsDto] })
  @RequireAdminAccess("TENANT", "geo.read")
  listTenantGeoEntities(@Param("tenantId") tenantId: string) {
    return this.content.listGeoEntities(tenantScope(tenantId));
  }

  @Post("console/tenants/:tenantId/geo-entities")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  createTenantGeoEntity(@Param("tenantId") tenantId: string, @Body() input: CreateGeoEntityDto) {
    return this.content.createGeoEntity(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/geo-entities/:entityId/versions")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  publishTenantGeoEntityVersion(
    @Param("tenantId") tenantId: string,
    @Param("entityId") entityId: string,
    @Body() input: PublishGeoEntityVersionDto,
  ) {
    return this.content.publishGeoEntityVersion(tenantScope(tenantId), entityId, input);
  }

  @Post("console/tenants/:tenantId/geo-entities/:entityId/disable")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  disableTenantGeoEntity(
    @Param("tenantId") tenantId: string,
    @Param("entityId") entityId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableGeoEntity(tenantScope(tenantId), entityId, input);
  }

  @Post("console/tenants/:tenantId/geo-topics")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  createTenantGeoTopic(@Param("tenantId") tenantId: string, @Body() input: CreateGeoTopicDto) {
    return this.content.createGeoTopic(tenantScope(tenantId), input);
  }

  @Post("console/tenants/:tenantId/geo-topics/:topicId/versions")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  publishTenantGeoTopicVersion(
    @Param("tenantId") tenantId: string,
    @Param("topicId") topicId: string,
    @Body() input: PublishGeoTopicVersionDto,
  ) {
    return this.content.publishGeoTopicVersion(tenantScope(tenantId), topicId, input);
  }

  @Post("console/tenants/:tenantId/geo-topics/:topicId/disable")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("TENANT", "tenant.shared-material.manage", "geo.manage")
  disableTenantGeoTopic(
    @Param("tenantId") tenantId: string,
    @Param("topicId") topicId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableGeoTopic(tenantScope(tenantId), topicId, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/materials")
  @ApiOkResponse({ type: [MaterialResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "material.read")
  listEnterpriseMaterials(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.content.listMaterials(enterpriseScope(tenantId, enterpriseId));
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/materials/options")
  @ApiOkResponse({ type: MaterialOptionsResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.read")
  enterpriseMaterialOptions(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.content.materialOptions(enterpriseScope(tenantId, enterpriseId));
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  createEnterpriseMaterial(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateMaterialDto,
  ) {
    return this.content.createMaterial(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/bulk-text")
  @ApiCreatedResponse({ type: BulkMaterialReportResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  bulkCreateEnterpriseMaterials(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: BulkCreateTextMaterialsDto,
  ) {
    return this.content.bulkCreateTextMaterials(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/material-upload-intents")
  @ApiCreatedResponse({ type: MaterialUploadIntentResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  createEnterpriseMaterialUploadIntent(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateMaterialUploadIntentDto,
  ) {
    return this.ingestion.createUploadIntent(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/revision")
  @ApiCreatedResponse({ type: MaterialRevisionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  createEnterpriseMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: CreateMaterialRevisionDto,
  ) {
    return this.ingestion.createRevision(
      enterpriseScope(tenantId, enterpriseId),
      materialId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/revision/resume")
  @ApiCreatedResponse({ type: MaterialRevisionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  resumeEnterpriseMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: CreateMaterialRevisionDto,
  ) {
    return this.ingestion.resumeRevision(
      enterpriseScope(tenantId, enterpriseId),
      materialId,
      input,
    );
  }

  @Post(
    "console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/revision/finalize",
  )
  @ApiCreatedResponse({ type: MaterialSupplementQueuedResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  finalizeEnterpriseMaterialRevision(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
  ) {
    return this.ingestion.finalizeRevision(enterpriseScope(tenantId, enterpriseId), materialId);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/material-links")
  @ApiCreatedResponse({ type: MaterialIngestionQueuedResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  createEnterpriseMaterialLink(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateMaterialLinkDto,
  ) {
    return this.ingestion.createLink(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post(
    "console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/artifacts/:artifactId/complete",
  )
  @ApiCreatedResponse({ type: MaterialIngestionQueuedResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  completeEnterpriseMaterialUpload(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Param("artifactId") artifactId: string,
    @Body() input: CompleteMaterialUploadDto,
  ) {
    return this.ingestion.completeUpload(
      enterpriseScope(tenantId, enterpriseId),
      materialId,
      artifactId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/ingestion/retry")
  @ApiCreatedResponse({ type: MaterialIngestionJobResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  retryEnterpriseMaterialIngestion(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: RetryMaterialIngestionDto,
  ) {
    return this.ingestion.retry(enterpriseScope(tenantId, enterpriseId), materialId, input);
  }

  @Get(
    "console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/artifacts/:artifactId/preview",
  )
  @ApiOkResponse({ type: MaterialArtifactPreviewResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.read")
  previewEnterpriseMaterialArtifact(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Param("artifactId") artifactId: string,
  ) {
    return this.ingestion.previewArtifact(
      enterpriseScope(tenantId, enterpriseId),
      materialId,
      artifactId,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/versions")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  publishEnterpriseMaterialVersion(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: PublishMaterialVersionDto,
  ) {
    return this.content.publishMaterialVersion(
      enterpriseScope(tenantId, enterpriseId),
      materialId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/materials/:materialId/disable")
  @ApiCreatedResponse({ type: MaterialResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  disableEnterpriseMaterial(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("materialId") materialId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableMaterial(enterpriseScope(tenantId, enterpriseId), materialId, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/sensitive-rules")
  @ApiOkResponse({ type: [SensitiveRuleResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "material.read")
  listEnterpriseSensitiveRules(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.content.listSensitiveRules(enterpriseScope(tenantId, enterpriseId));
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/sensitive-rules/import-csv")
  @ApiCreatedResponse({ type: SensitiveRuleImportReportResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  importEnterpriseSensitiveRulesCsv(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: ImportSensitiveRulesCsvDto,
  ) {
    return this.content.importSensitiveRulesCsv(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/sensitive-rules")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  createEnterpriseSensitiveRule(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateSensitiveRuleDto,
  ) {
    return this.content.createSensitiveRule(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/sensitive-rules/:ruleId/versions")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  publishEnterpriseSensitiveRuleVersion(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("ruleId") ruleId: string,
    @Body() input: PublishSensitiveRuleVersionDto,
  ) {
    return this.content.publishSensitiveRuleVersion(
      enterpriseScope(tenantId, enterpriseId),
      ruleId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/sensitive-rules/:ruleId/disable")
  @ApiCreatedResponse({ type: SensitiveRuleResponseDto })
  @RequireAdminAccess("ENTERPRISE", "material.manage")
  disableEnterpriseSensitiveRule(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("ruleId") ruleId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableSensitiveRule(
      enterpriseScope(tenantId, enterpriseId),
      ruleId,
      input,
    );
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/geo-entities")
  @ApiOkResponse({ type: [GeoEntityWithTopicsDto] })
  @RequireAdminAccess("ENTERPRISE", "geo.read")
  listEnterpriseGeoEntities(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.content.listGeoEntities(enterpriseScope(tenantId, enterpriseId));
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/focus-recommendations")
  @ApiOkResponse({ type: [FocusRecommendationDto] })
  @RequireAdminAccess("ENTERPRISE", "geo.read", "material.read")
  focusRecommendations(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.content.focusRecommendations(enterpriseScope(tenantId, enterpriseId));
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-entities")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  createEnterpriseGeoEntity(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateGeoEntityDto,
  ) {
    return this.content.createGeoEntity(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-entities/:entityId/versions")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  publishEnterpriseGeoEntityVersion(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("entityId") entityId: string,
    @Body() input: PublishGeoEntityVersionDto,
  ) {
    return this.content.publishGeoEntityVersion(
      enterpriseScope(tenantId, enterpriseId),
      entityId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-entities/:entityId/disable")
  @ApiCreatedResponse({ type: GeoEntityResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  disableEnterpriseGeoEntity(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("entityId") entityId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableGeoEntity(enterpriseScope(tenantId, enterpriseId), entityId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-topics")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  createEnterpriseGeoTopic(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateGeoTopicDto,
  ) {
    return this.content.createGeoTopic(enterpriseScope(tenantId, enterpriseId), input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-topics/:topicId/versions")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  publishEnterpriseGeoTopicVersion(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("topicId") topicId: string,
    @Body() input: PublishGeoTopicVersionDto,
  ) {
    return this.content.publishGeoTopicVersion(
      enterpriseScope(tenantId, enterpriseId),
      topicId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/geo-topics/:topicId/disable")
  @ApiCreatedResponse({ type: GeoTopicResponseDto })
  @RequireAdminAccess("ENTERPRISE", "geo.manage")
  disableEnterpriseGeoTopic(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("topicId") topicId: string,
    @Body() input: DisableContentDto,
  ) {
    return this.content.disableGeoTopic(enterpriseScope(tenantId, enterpriseId), topicId, input);
  }
}

function tenantScope(tenantId: string) {
  return { enterpriseId: null, tenantId } as const;
}

function enterpriseScope(tenantId: string, enterpriseId: string) {
  return { enterpriseId, tenantId } as const;
}
