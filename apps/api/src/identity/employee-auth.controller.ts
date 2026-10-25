import { Body, Controller, Inject, Ip, Post } from "@nestjs/common";
import { ApiCreatedResponse } from "@nestjs/swagger";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  BindEmployeeDto,
  RequestEmployeeCodeDto,
  VerifyEmployeeCodeDto,
} from "./employee-auth.dto";
import { EmployeeAuthenticationService } from "./employee-auth.service";
import {
  EmployeeCandidatesResponseDto,
  EmployeeCodeResponseDto,
  EmployeeTokenResponseDto,
} from "./identity-response.dto";

@Controller("auth/employee")
export class EmployeeAuthenticationController {
  constructor(
    @Inject(EmployeeAuthenticationService)
    private readonly authentication: EmployeeAuthenticationService,
  ) {}

  @Post("request-code")
  @ApiCreatedResponse({ type: EmployeeCodeResponseDto })
  requestCode(@Body() input: RequestEmployeeCodeDto, @Ip() ip: string) {
    return this.authentication.requestCode(input, ip);
  }

  @Post("debug/request-code")
  @ApiCreatedResponse({ type: EmployeeCodeResponseDto })
  requestDebugCode(@Body() input: RequestEmployeeCodeDto, @Ip() ip: string) {
    return this.authentication.requestDebugCode(input, ip);
  }

  @Post("bind")
  @ApiCreatedResponse({ type: EmployeeTokenResponseDto })
  bind(@Body() input: BindEmployeeDto) {
    return this.authentication.bind(input);
  }

  @Post("debug/bind")
  @ApiCreatedResponse({ type: EmployeeTokenResponseDto })
  debugBind(@Body() input: BindEmployeeDto, @Ip() ip: string) {
    return this.authentication.debugBind(input, ip);
  }

  @Post("candidates")
  @ApiCreatedResponse({ type: EmployeeCandidatesResponseDto })
  candidates(@Body() input: VerifyEmployeeCodeDto) {
    return this.authentication.candidates(input);
  }

  @Post("debug/candidates")
  @ApiCreatedResponse({ type: EmployeeCandidatesResponseDto })
  debugCandidates(@Body() input: VerifyEmployeeCodeDto, @Ip() ip: string) {
    return this.authentication.debugCandidates(input, ip);
  }
}
