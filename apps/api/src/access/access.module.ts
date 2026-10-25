import { Module } from "@nestjs/common";
import { PrismaModule } from "../database/prisma.module";
import { AdminAccessGuard } from "./admin-access.guard";
import { AdminTokenAuthenticator } from "./admin-token-authenticator";
import { AuthTokenService } from "./auth-token.service";
import { AuthorizationRepository } from "./authorization.repository";
import { EmployeeAccessGuard } from "./employee-access.guard";
import { RequestAccessContext } from "./request-access-context";

@Module({
  exports: [
    AdminAccessGuard,
    AdminTokenAuthenticator,
    AuthorizationRepository,
    AuthTokenService,
    EmployeeAccessGuard,
    RequestAccessContext,
  ],
  imports: [PrismaModule],
  providers: [
    AdminAccessGuard,
    AdminTokenAuthenticator,
    AuthorizationRepository,
    AuthTokenService,
    EmployeeAccessGuard,
    RequestAccessContext,
  ],
})
export class AccessModule {}
