import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { IsString, Matches } from "class-validator";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
import { PasswordLoginDto } from "./admin-auth.dto";
import { EmployeeWebService } from "./employee-web.service";
import { EmployeeTokenResponseDto } from "./identity-response.dto";

export class EmployeeWebBindDto {
  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{43}$" })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  token!: string;
}
export class EmployeeWebInvitationDto {
  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{43}$" })
  token!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: Date;
}

export class EmployeeWebAccountDto extends PasswordLoginDto {}

export class EmployeeWebAccountResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty() username!: string;
  @ApiProperty() membershipId!: string;
}

@Controller("auth/employee")
@ApiTags("Employee Web Identity")
@ApiBearerAuth("access-token")
export class EmployeeWebController {
  constructor(@Inject(EmployeeWebService) private readonly employees: EmployeeWebService) {}

  @Post("web-bind")
  @HttpCode(200)
  @ApiOkResponse({ type: EmployeeTokenResponseDto })
  @ApiOperation({ summary: "登录后消费一次性员工邀请，绑定本人发布身份" })
  bind(
    @Headers("authorization") authorization: string | undefined,
    @Body() input: EmployeeWebBindDto,
  ) {
    return this.employees.bind(authorization, input.token);
  }

  @Post("web-session")
  @HttpCode(200)
  @ApiOkResponse({ type: EmployeeTokenResponseDto })
  @ApiOperation({ summary: "将正式账号会话换取已绑定的员工访问令牌" })
  session(@Headers("authorization") authorization: string | undefined) {
    return this.employees.session(authorization);
  }
}

@Controller("console/tenants/:tenantId/enterprises/:enterpriseId/memberships")
@UseGuards(AdminAccessGuard)
@ApiTags("Employee Web Identity")
@ApiBearerAuth("access-token")
export class EmployeeWebInvitationController {
  constructor(@Inject(EmployeeWebService) private readonly employees: EmployeeWebService) {}

  @Post(":membershipId/web-account")
  @HttpCode(200)
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  @ApiOkResponse({ type: EmployeeWebAccountResponseDto })
  @ApiOperation({ summary: "由企业管理员为未绑定成员创建账号密码并绑定员工身份" })
  createAccount(@Param("membershipId") membershipId: string, @Body() input: EmployeeWebAccountDto) {
    return this.employees.createAccount(membershipId, input);
  }

  @Post(":membershipId/web-invitation")
  @HttpCode(403)
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  @ApiForbiddenResponse({ description: "自助注册已关闭" })
  @ApiOperation({ summary: "已停用：请使用管理员创建员工账号接口", deprecated: true })
  invitation(@Param("membershipId") membershipId: string) {
    return this.employees.invitation(membershipId);
  }
}
