import { Body, Controller, Inject, Post } from "@nestjs/common";
import { ApiCreatedResponse } from "@nestjs/swagger";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { DevelopmentAdminTokenDto, DevelopmentEmployeeBindDto } from "./dev-auth.dto";
import { DevelopmentAuthService } from "./dev-auth.service";
import {
  DevelopmentAdminTokenResponseDto,
  EmployeeTokenResponseDto,
} from "./identity-response.dto";

@Controller("auth/dev")
export class DevelopmentAuthController {
  constructor(
    @Inject(DevelopmentAuthService) private readonly developmentAuth: DevelopmentAuthService,
  ) {}

  @Post("admin-token")
  @ApiCreatedResponse({ type: DevelopmentAdminTokenResponseDto })
  issueAdminToken(@Body() input: DevelopmentAdminTokenDto) {
    return this.developmentAuth.issueAdminToken(input);
  }

  @Post("employee-bind")
  @ApiCreatedResponse({ type: EmployeeTokenResponseDto })
  bindEmployee(@Body() input: DevelopmentEmployeeBindDto) {
    return this.developmentAuth.bindEmployeeAndIssueToken(input);
  }
}
