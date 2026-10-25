import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthTokenService } from "../access/auth-token.service";
import { PrismaService } from "../database/prisma.service";
import { normalizeChineseMobilePhone } from "../employee/phone";
import type { DevelopmentAdminTokenDto, DevelopmentEmployeeBindDto } from "./dev-auth.dto";
import { EmployeeBindingService } from "./employee-binding.service";

@Injectable()
export class DevelopmentAuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
    @Inject(EmployeeBindingService) private readonly employeeBinding: EmployeeBindingService,
  ) {}

  async issueAdminToken(input: DevelopmentAdminTokenDto) {
    this.assertEnabled();
    const phone = normalizePhone(input.phone);
    const user = await this.prisma.adminUser.findFirst({
      select: { id: true },
      where: {
        phone,
        roleBindings: { some: { role: { status: "ACTIVE" } } },
        status: "ACTIVE",
      },
    });
    if (!user) {
      throw new NotFoundException("Active SaaS administrator was not found");
    }
    return {
      accessToken: this.tokens.issueAdminAccessToken(user.id),
      audience: "xhs-saas-admin",
      expiresInSeconds: this.tokens.accessTokenTtlSeconds,
      tokenType: "Bearer",
      userId: user.id,
    };
  }

  async bindEmployeeAndIssueToken(input: DevelopmentEmployeeBindDto) {
    this.assertEnabled();
    return this.employeeBinding.bindVerifiedPhone(input);
  }

  private assertEnabled(): void {
    if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_AUTH !== "true") {
      throw new ForbiddenException("Development authentication is disabled");
    }
  }
}

function normalizePhone(phone: string): string {
  try {
    return normalizeChineseMobilePhone(phone);
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "Phone is invalid");
  }
}
