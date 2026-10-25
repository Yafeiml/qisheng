import { ApiProperty } from "@nestjs/swagger";

export class CursorPageInfoDto {
  hasNextPage!: boolean;

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
