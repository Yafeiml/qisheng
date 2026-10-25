export class IndustryDto {
  id!: string;
  name!: string;
  sortOrder!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class IndustryManagementDto extends IndustryDto {
  generationGuidance!: string;
}
