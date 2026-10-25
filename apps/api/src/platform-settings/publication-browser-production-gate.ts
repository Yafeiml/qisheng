import { ConflictException } from "@nestjs/common";

// Browser collection still lacks real-account P-014 acceptance and durable
// screenshot evidence. Keep local development available until both gates pass.
export function assertPublicationBrowserProductionReady(mode: string): void {
  if (mode !== "BROWSER" || process.env.NODE_ENV !== "production") return;
  throw new ConflictException({
    code: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY",
    message: "生产浏览器验真须先完成独立 P-014 实测及截图存证验收",
  });
}
