import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiProperty, ApiTags } from "@nestjs/swagger";
import { PlatformSettingsReader } from "./platform-settings.reader";

export class PublicPlatformBrandingDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  logoDataUrl!: string | null;
}

@ApiTags("Platform Branding")
@Controller("public/platform-branding")
export class PlatformBrandingController {
  constructor(@Inject(PlatformSettingsReader) private readonly reader: PlatformSettingsReader) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ type: PublicPlatformBrandingDto })
  async current(): Promise<PublicPlatformBrandingDto> {
    // This public endpoint exposes only the two display fields, never the settings catalogue.
    const values = await this.reader.resolveMany([
      "general.platform_name",
      "general.platform_logo",
    ]);
    return {
      name: String(values.get("general.platform_name")?.value ?? "管理平台"),
      logoDataUrl: String(values.get("general.platform_logo")?.value ?? "") || null,
    };
  }
}
