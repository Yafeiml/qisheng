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
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  AdminSmsSettingsResponseDto,
  AdminSmsTestResponseDto,
  SaveAdminSmsSettingsDto,
  TestAdminSmsDto,
} from "./admin-sms-settings.dto";
import { AdminSmsSettingsService } from "./admin-sms-settings.service";
// biome-ignore lint/style/useImportType: NestJS needs the request DTO class for production validation metadata.
import {
  ContentSafetySettingsResponseDto,
  SaveContentSafetySettingsDto,
} from "./content-safety-settings.dto";
import { PlatformContentSafetyService } from "./platform-content-safety.service";
import { PlatformPublicationVerificationService } from "./platform-publication-verification.service";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  ApplyPlatformStorageLifecycleDto,
  RegisterPublicationPolicyEvidenceDto,
  SaveMiniappDebugSettingsDto,
  TestPlatformContentSafetyDto,
  TestPlatformPublicationVerificationDto,
  TestPlatformStorageDto,
  UpdatePlatformSettingDto,
} from "./platform-settings.dto";
import { PlatformSettingsService } from "./platform-settings.service";
import {
  PlatformContentSafetyTestResponseDto,
  PlatformPublicationVerificationTestResponseDto,
  PlatformSettingItemDto,
  PlatformSettingsResponseDto,
  PlatformStorageLifecycleResponseDto,
  PlatformStorageTestResponseDto,
  PublicationPolicyEvidenceResponseDto,
} from "./platform-settings-response.dto";
import { PublicationPolicyEvidenceService } from "./publication-policy-evidence.service";

@ApiTags("Platform Settings")
@Controller("platform/settings")
@UseGuards(AdminAccessGuard)
export class PlatformSettingsController {
  constructor(
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
    @Inject(AdminSmsSettingsService) private readonly adminSms: AdminSmsSettingsService,
    @Inject(PlatformContentSafetyService)
    private readonly contentSafety: PlatformContentSafetyService,
    @Inject(PlatformPublicationVerificationService)
    private readonly publicationVerification: PlatformPublicationVerificationService,
    @Inject(PublicationPolicyEvidenceService)
    private readonly publicationPolicyEvidence: PublicationPolicyEvidenceService,
  ) {}

  @Get()
  @ApiOkResponse({ type: PlatformSettingsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  list() {
    return this.settings.list();
  }

  @Post("miniapp-debug")
  @ApiOkResponse({ type: PlatformSettingsResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  saveMiniappDebug(@Body() input: SaveMiniappDebugSettingsDto) {
    return this.settings.saveMiniappDebug(input);
  }

  @Get("admin-sms")
  @ApiOkResponse({ type: AdminSmsSettingsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  adminSmsSettings() {
    return this.adminSms.current();
  }

  @Post("admin-sms")
  @ApiOkResponse({ type: AdminSmsSettingsResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  saveAdminSms(@Body() input: SaveAdminSmsSettingsDto) {
    return this.adminSms.save(input);
  }

  @Post("admin-sms/test")
  @ApiOkResponse({ type: AdminSmsTestResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  testAdminSms(@Body() input: TestAdminSmsDto) {
    return this.adminSms.test(input.phone);
  }

  @Post("storage/test")
  @ApiOkResponse({ type: PlatformStorageTestResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  testStorage(@Body() input: TestPlatformStorageDto) {
    return this.settings.testStorage(input.reason);
  }

  @Post("content-safety/test")
  @ApiOkResponse({ type: PlatformContentSafetyTestResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  testContentSafety(@Body() input: TestPlatformContentSafetyDto) {
    return this.contentSafety.test(input.reason);
  }

  @Get("content-safety")
  @ApiOkResponse({ type: ContentSafetySettingsResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  contentSafetySettings() {
    return this.contentSafety.configuration();
  }

  @Post("content-safety")
  @ApiOkResponse({ type: ContentSafetySettingsResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  saveContentSafety(@Body() input: SaveContentSafetySettingsDto) {
    return this.contentSafety.save(input);
  }

  @Post("publication-verification/test")
  @ApiOkResponse({ type: PlatformPublicationVerificationTestResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  testPublicationVerification(@Body() input: TestPlatformPublicationVerificationDto) {
    return this.publicationVerification.test(input.url, input.reason);
  }

  @Get("publication-verification/evidence")
  @ApiOkResponse({ type: PublicationPolicyEvidenceResponseDto })
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  publicationVerificationEvidence() {
    return this.publicationPolicyEvidence.platformCurrent();
  }

  @Post("publication-verification/evidence")
  @ApiOkResponse({ type: PublicationPolicyEvidenceResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  registerPublicationVerificationEvidence(@Body() input: RegisterPublicationPolicyEvidenceDto) {
    return this.publicationPolicyEvidence.register(input);
  }

  @Post("storage/lifecycle/apply")
  @ApiOkResponse({ type: PlatformStorageLifecycleResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  applyStorageLifecycle(@Body() input: ApplyPlatformStorageLifecycleDto) {
    return this.settings.applyStorageLifecycle(input.reason);
  }

  @Post(":key")
  @ApiOkResponse({ type: PlatformSettingItemDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.settings.manage")
  update(@Param("key") key: string, @Body() input: UpdatePlatformSettingDto) {
    return this.settings.update(key, input);
  }
}
