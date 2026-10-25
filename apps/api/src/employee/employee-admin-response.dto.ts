import { ApiProperty } from "@nestjs/swagger";

export class DepartmentResponseDto {
  code!: string;
  createdAt!: string;
  enterpriseId!: string;
  id!: string;
  name!: string;
  status!: string;
  tenantId!: string;
  updatedAt!: string;
}

export class DepartmentImpactResponseDto {
  enabledSeatCount!: number;
  memberCount!: number;
  sampleMemberNames!: string[];
}

export class ImportedMembershipSummaryDto {
  id!: string;
  seatStatus!: "ENABLED" | "NOT_ENABLED";
  status!: "ACTIVE" | "DISABLED" | "LEFT" | "PENDING_BIND";
}

export class MembershipImportResponseDto {
  batchId!: string;
  count!: number;
  createdCount!: number;
  memberships!: ImportedMembershipSummaryDto[];
  updatedCount!: number;
}

export class ImportRowErrorDto {
  code!: string;
  message!: string;
}

export class NormalizedImportRowDto {
  @ApiProperty({ nullable: true, type: String })
  departmentCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  employeeNo!: string | null;

  maskedPhone!: string;
  name!: string;
}

export class MembershipImportPreviewRowDto {
  action!: "CREATE" | "ERROR" | "UPDATE";
  errors!: ImportRowErrorDto[];
  normalized!: NormalizedImportRowDto;
  rowNumber!: number;
}

export class MembershipImportSummaryDto {
  createCount!: number;
  errorCount!: number;
  totalCount!: number;
  updateCount!: number;
}

export class MembershipImportPreviewDto {
  batchId!: string;
  canImport!: boolean;
  fileErrors!: ImportRowErrorDto[];
  rows!: MembershipImportPreviewRowDto[];
  summary!: MembershipImportSummaryDto;
}

export class MembershipImportBatchResponseDto {
  createCount!: number;
  createdAt!: string;
  createdBy!: string;
  enterpriseId!: string;
  errorCount!: number;

  @ApiProperty({ nullable: true, type: String })
  fileName!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  importedAt!: string | null;

  report!: Record<string, unknown>;
  rowCount!: number;
  source!: string;
  status!: "IMPORTED" | "PREVIEW_FAILED" | "PREVIEW_READY";
  tenantId!: string;
  updateCount!: number;
  updatedAt!: string;
}

export class BulkMembershipActionResponseDto {
  action!: "DISABLE" | "ENABLE" | "LEAVE" | "TRANSFER";
  updatedCount!: number;
}
