import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfirmAdminEmailDto, UpdateAdminAccountDto } from "./admin-account.dto";
import { AdminAccountService } from "./admin-account.service";
import {
  AdminAccountDto,
  AdminEmailConfirmedDto,
  AdminEmailSendDto,
  AdminEmailStatusDto,
} from "./admin-account-response.dto";
import { AdminEmailVerificationService } from "./admin-email-verification.service";
import { ProtectedSmsRequestDto, SmsChallengeResponseDto } from "./sms-security.dto";

@Controller("auth/admin/account")
@ApiBearerAuth("access-token")
@ApiTags("Administrator Identity")
export class AdminAccountController {
  constructor(
    @Inject(AdminAccountService) private readonly accounts: AdminAccountService,
    @Inject(AdminEmailVerificationService) private readonly emails: AdminEmailVerificationService,
  ) {}

  @Get("email/status")
  @ApiOperation({ summary: "读取当前管理员验证邮件剩余发送等待时间" })
  @ApiOkResponse({ type: AdminEmailStatusDto })
  emailStatus(@Headers("authorization") authorization: string | undefined, @Ip() ip: string) {
    return this.emails.status(authorization, ip);
  }

  @Post("email/challenge")
  @HttpCode(200)
  @ApiOperation({ summary: "获取当前管理员邮箱验证邮件的 CAP 安全验证" })
  @ApiOkResponse({ type: SmsChallengeResponseDto })
  challenge(@Headers("authorization") authorization: string | undefined, @Ip() ip: string) {
    return this.emails.challenge(authorization, ip);
  }

  @Post("email/send")
  @HttpCode(200)
  @ApiOperation({ summary: "向当前管理员已保存的邮箱发送限流验证链接" })
  @ApiBody({ type: ProtectedSmsRequestDto })
  @ApiOkResponse({ type: AdminEmailSendDto })
  sendEmail(
    @Headers("authorization") authorization: string | undefined,
    @Ip() ip: string,
    @Body() input: ProtectedSmsRequestDto,
  ) {
    return this.emails.send(authorization, ip, input.captcha);
  }

  @Get()
  @ApiOperation({ summary: "读取当前后台用户的个人账户资料" })
  @ApiOkResponse({ type: AdminAccountDto })
  getAccount(@Headers("authorization") authorization: string | undefined) {
    return this.accounts.getAccount(authorization);
  }

  @Patch()
  @ApiOperation({ summary: "更新当前后台用户可自助维护的个人资料" })
  @ApiBody({ type: UpdateAdminAccountDto })
  @ApiOkResponse({ type: AdminAccountDto })
  updateAccount(
    @Headers("authorization") authorization: string | undefined,
    @Body() input: UpdateAdminAccountDto,
  ) {
    return this.accounts.updateAccount(authorization, input);
  }
}

@Controller("auth/admin/email")
@ApiTags("Administrator Identity")
export class AdminEmailConfirmationController {
  constructor(
    @Inject(AdminEmailVerificationService) private readonly emails: AdminEmailVerificationService,
  ) {}

  @Post("confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "主动确认邮箱一次性验证链接，无需登录" })
  @ApiBody({ type: ConfirmAdminEmailDto })
  @ApiOkResponse({ type: AdminEmailConfirmedDto })
  confirm(@Body() input: ConfirmAdminEmailDto) {
    return this.emails.confirm(input.token);
  }
}
