import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
import { ModelIncidentRetryResponseDto } from "./generation-status.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  ConfigureModelRouteDto,
  CreateModelDefinitionDto,
  CreateModelProviderDto,
  QualifyModelRouteDto,
  ResetModelProviderCircuitDto,
  RevokeModelProviderCredentialDto,
  RotateModelProviderCredentialDto,
  UpdateModelDefinitionDto,
  UpdateModelProviderDto,
} from "./model-configuration.dto";
import { ModelConfigurationService } from "./model-configuration.service";
import {
  ModelCatalogResponseDto,
  ModelDefinitionResponseDto,
  ModelProviderHealthCheckResponseDto,
  ModelProviderResponseDto,
  ModelRouteQualificationResponseDto,
  ModelRouteResponseDto,
} from "./model-configuration-response.dto";
import { ModelIncidentMonitor } from "./model-incident-monitor.service";
import { ModelQualificationService } from "./model-qualification.service";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  AvailableModelsResponseDto,
  SaveModelSetupDto,
  SaveModelSetupResponseDto,
  SaveProviderConnectionDto,
} from "./model-setup.dto";
import { ModelSetupService } from "./model-setup.service";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { UpdateRuntimePolicyDto } from "./runtime-policy.dto";
import { RuntimePolicyService } from "./runtime-policy.service";
import { RuntimePolicyResponseDto } from "./runtime-policy-response.dto";

@Controller("platform")
@UseGuards(AdminAccessGuard)
export class ModelConfigurationController {
  constructor(
    @Inject(ModelIncidentMonitor) private readonly incidents: ModelIncidentMonitor,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(ModelQualificationService)
    private readonly qualifications: ModelQualificationService,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(ModelSetupService) private readonly setup: ModelSetupService,
  ) {}

  @Get("model-providers/:providerId/available-models")
  @ApiOkResponse({ type: AvailableModelsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  availableModels(@Param("providerId") providerId: string) {
    return this.setup.availableModels(providerId);
  }

  @Post("model-setup")
  @ApiOkResponse({ type: SaveModelSetupResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  saveSetup(@Body() input: SaveModelSetupDto) {
    return this.setup.save(input);
  }

  @Post("model-providers/:providerId/connection")
  @ApiOkResponse({ type: ModelProviderResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  saveConnection(
    @Param("providerId") providerId: string,
    @Body() input: SaveProviderConnectionDto,
  ) {
    return this.setup.saveConnection(providerId, input);
  }

  @Get("runtime-policy")
  @ApiOkResponse({ type: RuntimePolicyResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  currentRuntimePolicy() {
    return this.runtimePolicy.platformCurrent();
  }

  @Post("runtime-policy")
  @ApiOkResponse({ type: RuntimePolicyResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  updateRuntimePolicy(@Body() input: UpdateRuntimePolicyDto) {
    return this.runtimePolicy.update(input);
  }

  @Get("model-catalog")
  @ApiOkResponse({ type: ModelCatalogResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  catalog() {
    return this.models.catalog();
  }

  @Post("model-providers")
  @ApiCreatedResponse({ type: ModelProviderResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  createProvider(@Body() input: CreateModelProviderDto) {
    return this.models.createProvider(input);
  }

  @Post("model-providers/:providerId/settings")
  @ApiOkResponse({ type: ModelProviderResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  updateProvider(@Param("providerId") providerId: string, @Body() input: UpdateModelProviderDto) {
    return this.models.updateProvider(providerId, input);
  }

  @Post("model-providers/:providerId/credentials/rotate")
  @ApiCreatedResponse({ type: ModelProviderResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  rotateCredential(
    @Param("providerId") providerId: string,
    @Body() input: RotateModelProviderCredentialDto,
  ) {
    return this.models.rotateCredential(providerId, input);
  }

  @Post("model-providers/:providerId/credentials/revoke")
  @ApiOkResponse({ type: ModelProviderResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  revokeCredential(
    @Param("providerId") providerId: string,
    @Body() input: RevokeModelProviderCredentialDto,
  ) {
    return this.models.revokeCredential(providerId, input);
  }

  @Post("model-providers/:providerId/test-connection")
  @ApiCreatedResponse({ type: ModelProviderHealthCheckResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  testConnection(@Param("providerId") providerId: string) {
    return this.models.testConnection(providerId);
  }

  @Post("model-providers/:providerId/circuit/reset")
  @ApiOkResponse({ type: ModelProviderResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  resetCircuit(
    @Param("providerId") providerId: string,
    @Body() input: ResetModelProviderCircuitDto,
  ) {
    return this.models.resetProviderCircuit(providerId, input);
  }

  @Post("model-providers/:providerId/models")
  @ApiCreatedResponse({ type: ModelDefinitionResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  createModel(@Param("providerId") providerId: string, @Body() input: CreateModelDefinitionDto) {
    return this.models.createModel(providerId, input);
  }

  @Post("model-definitions/:modelId/settings")
  @ApiOkResponse({ type: ModelDefinitionResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  updateModel(@Param("modelId") modelId: string, @Body() input: UpdateModelDefinitionDto) {
    return this.models.updateModel(modelId, input);
  }

  @Post("model-routes")
  @ApiCreatedResponse({ type: ModelRouteResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  configureRoute(@Body() input: ConfigureModelRouteDto) {
    return this.models.configureRoute(input);
  }

  @Post("model-routes/:routeId/retry-notification")
  @ApiOkResponse({ type: ModelIncidentRetryResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  retryNotification(@Param("routeId") routeId: string) {
    return this.incidents.retryNotification(routeId);
  }

  @Post("model-routes/:routeId/qualify")
  @ApiCreatedResponse({ type: ModelRouteQualificationResponseDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.model.manage")
  qualifyRoute(@Param("routeId") routeId: string, @Body() input: QualifyModelRouteDto = {}) {
    return this.qualifications.qualify(routeId, input.requiresImage !== false);
  }
}
