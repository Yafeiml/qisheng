import { Controller, Get, Headers, Inject } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminSessionService } from "./admin-session.service";
import { AdminSessionProfileDto } from "./identity-response.dto";

@Controller("auth/admin")
export class AdminSessionController {
  constructor(@Inject(AdminSessionService) private readonly sessions: AdminSessionService) {}

  @Get("session")
  @ApiOkResponse({ type: AdminSessionProfileDto })
  session(@Headers("authorization") authorization: string | undefined) {
    return this.sessions.getSession(authorization);
  }
}
