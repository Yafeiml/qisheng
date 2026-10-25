import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Post, Res } from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  AdminCodeResponseDto,
  AdminTokenResponseDto,
  InitializeInstallationDto,
  InstallationStatusDto,
  LoginAdminDto,
  PasswordLoginDto,
  PasswordRegisterDto,
  RequestAdminCodeDto,
} from "./admin-auth.dto";
import { AdminAuthenticationService } from "./admin-auth.service";
import {
  type CookieResponse,
  clearAdminRefreshCookie,
  refreshTokenFromCookie,
  setAdminRefreshCookie,
} from "./admin-refresh-cookie";

@Controller("auth/admin")
@ApiTags("Administrator Identity")
export class AdminAuthenticationController {
  constructor(
    @Inject(AdminAuthenticationService)
    private readonly authentication: AdminAuthenticationService,
  ) {}

  @Get("installation")
  @ApiOperation({ summary: "查询当前安装是否已有管理员或组织" })
  @ApiOkResponse({ type: InstallationStatusDto })
  installationStatus() {
    return this.authentication.installationStatus();
  }

  @Post("installation")
  @HttpCode(201)
  @ApiOperation({ summary: "凭安装密钥完成唯一一次管理员与企业或集团初始化" })
  @ApiCreatedResponse({ type: AdminTokenResponseDto })
  async initializeInstallation(
    @Body() input: InitializeInstallationDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authentication.initializeInstallation(input, userAgent);
    setAdminRefreshCookie(response, result.refreshToken, secondsUntil(result.refreshExpiresAt));
    return publicAuthResult(result);
  }

  @Post("register")
  @HttpCode(403)
  @ApiOperation({ summary: "自助注册已关闭；账号由管理员创建", deprecated: true })
  @ApiForbiddenResponse({ description: "自助注册已关闭，账号由管理员创建" })
  async register(
    @Body() input: PasswordRegisterDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authentication.register(input, ip, userAgent);
    setAdminRefreshCookie(response, result.refreshToken, secondsUntil(result.refreshExpiresAt));
    return publicAuthResult(result);
  }

  @Post("password-login")
  @HttpCode(200)
  @ApiOperation({ summary: "使用账号密码建立可撤销管理会话" })
  @ApiOkResponse({ type: AdminTokenResponseDto })
  async passwordLogin(
    @Body() input: PasswordLoginDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authentication.passwordLogin(input, ip, userAgent);
    setAdminRefreshCookie(response, result.refreshToken, secondsUntil(result.refreshExpiresAt));
    return publicAuthResult(result);
  }

  @Post("request-code")
  @HttpCode(202)
  @ApiOperation({ summary: "请求管理员登录验证码" })
  @ApiAcceptedResponse({ type: AdminCodeResponseDto })
  requestCode(@Body() input: RequestAdminCodeDto, @Ip() ip: string) {
    return this.authentication.requestCode(input, ip);
  }

  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "验证手机号并建立可撤销管理会话" })
  @ApiBody({ type: LoginAdminDto })
  @ApiOkResponse({ type: AdminTokenResponseDto })
  async login(
    @Body() input: LoginAdminDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authentication.login(input, userAgent);
    setAdminRefreshCookie(response, result.refreshToken, secondsUntil(result.refreshExpiresAt));
    return publicAuthResult(result);
  }

  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "轮换 Refresh Token 并签发短期 Access Token" })
  @ApiCookieAuth("xhs_admin_refresh")
  @ApiOkResponse({ type: AdminTokenResponseDto })
  async refresh(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authentication.refresh(refreshTokenFromCookie(cookie));
    setAdminRefreshCookie(response, result.refreshToken, secondsUntil(result.refreshExpiresAt));
    return publicAuthResult(result);
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "注销当前管理会话" })
  @ApiCookieAuth("xhs_admin_refresh")
  @ApiNoContentResponse()
  async logout(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.authentication.logout(refreshTokenFromCookie(cookie));
    clearAdminRefreshCookie(response);
  }

  @Post("logout-all")
  @HttpCode(204)
  @ApiOperation({ summary: "注销当前管理员的全部会话" })
  @ApiBearerAuth("access-token")
  @ApiNoContentResponse()
  async logoutAll(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.authentication.logoutAll(authorization);
    clearAdminRefreshCookie(response);
  }
}

function publicAuthResult(result: {
  accessToken: string;
  expiresInSeconds: number;
  refreshExpiresAt: Date;
  sessionId: string;
}) {
  return {
    accessToken: result.accessToken,
    audience: "xhs-saas-admin",
    expiresInSeconds: result.expiresInSeconds,
    refreshExpiresAt: result.refreshExpiresAt,
    sessionId: result.sessionId,
    tokenType: "Bearer",
  };
}

function secondsUntil(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}
