import { ApiProperty } from "@nestjs/swagger";
import type { CursorPageInfoDto } from "../http/cursor-page.dto";

export class AuditActorDto {
  @ApiProperty({ nullable: true, type: String })
  id!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;
}

export class AuditLogDto {
  action!: string;
  actor!: AuditActorDto;

  @ApiProperty({ enum: ["INTEGRATION", "SYSTEM", "USER"] })
  actorType!: "INTEGRATION" | "SYSTEM" | "USER";

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  requestId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  resourceId!: string | null;

  resourceType!: string;

  @ApiProperty({ nullable: true, type: String })
  tenantId!: string | null;
}

export class AuditLogPageDto {
  items!: AuditLogDto[];
  pageInfo!: CursorPageInfoDto;
}
