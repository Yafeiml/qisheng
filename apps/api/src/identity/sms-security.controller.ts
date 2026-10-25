import { Body, Controller, HttpCode, Inject, Ip, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
// biome-ignore lint/style/useImportType: NestJS DTO runtime validation.
import {
  PasswordChallengeRequestDto,
  SmsChallengeRequestDto,
  SmsChallengeResponseDto,
} from "./sms-security.dto";
import { SmsSecurityService } from "./sms-security.service";

@Controller("auth/captcha")
@ApiTags("SMS Security")
export class SmsSecurityController {
  constructor(@Inject(SmsSecurityService) private readonly security: SmsSecurityService) {}

  @Post("challenge")
  @HttpCode(200)
  @ApiOperation({ summary: "获取绑定手机号、用途和来源的一次性短信安全验证" })
  @ApiOkResponse({ type: SmsChallengeResponseDto })
  challenge(@Body() input: SmsChallengeRequestDto, @Ip() ip: string) {
    return this.security.challenge(input, ip);
  }

  @Post("password-challenge")
  @HttpCode(200)
  @ApiOperation({ summary: "获取账号密码登录或注册的可选 Cap 验证" })
  @ApiOkResponse({ type: SmsChallengeResponseDto })
  passwordChallenge(@Body() input: PasswordChallengeRequestDto, @Ip() ip: string) {
    return this.security.passwordChallenge(input.username, input.purpose, ip);
  }
}
