import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { NotificationMailer } from "../notifications/notification-mailer";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import {
  AdminAccountController,
  AdminEmailConfirmationController,
} from "./admin-account.controller";
import { AdminAccountService } from "./admin-account.service";
import { AdminAuthenticationController } from "./admin-auth.controller";
import { AdminAuthenticationService } from "./admin-auth.service";
import { AdminEmailVerificationService } from "./admin-email-verification.service";
import { AdminSessionController } from "./admin-session.controller";
import { AdminSessionService } from "./admin-session.service";
import { AdminSmsService } from "./admin-sms.service";
import { DevelopmentAuthController } from "./dev-auth.controller";
import { DevelopmentAuthService } from "./dev-auth.service";
import { EmployeeAuthenticationController } from "./employee-auth.controller";
import { EmployeeAuthenticationService } from "./employee-auth.service";
import { EmployeeBindingService } from "./employee-binding.service";
import { EmployeeWebController, EmployeeWebInvitationController } from "./employee-web.controller";
import { EmployeeWebService } from "./employee-web.service";
import { SmsSecurityController } from "./sms-security.controller";
import { SmsSecurityService } from "./sms-security.service";

@Module({
  controllers: [
    SmsSecurityController,
    EmployeeWebController,
    EmployeeWebInvitationController,
    AdminAccountController,
    AdminEmailConfirmationController,
    AdminSessionController,
    AdminAuthenticationController,
    DevelopmentAuthController,
    EmployeeAuthenticationController,
  ],
  imports: [AccessModule, PlatformSettingsModule, PrismaModule],
  exports: [AdminSmsService, SmsSecurityService],
  providers: [
    SmsSecurityService,
    EmployeeWebService,
    AdminAccountService,
    AdminEmailVerificationService,
    NotificationMailer,
    AdminSessionService,
    AdminSmsService,
    AdminAuthenticationService,
    DevelopmentAuthService,
    EmployeeAuthenticationService,
    EmployeeBindingService,
  ],
})
export class IdentityModule {}
