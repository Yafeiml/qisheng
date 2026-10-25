export type PlatformBranding = Readonly<{ name: string; logoDataUrl: string | null }>;
export const defaultPlatformBranding: PlatformBranding = { name: "管理平台", logoDataUrl: null };

export function parsePlatformBranding(value: unknown): PlatformBranding {
  if (!value || typeof value !== "object") throw new Error("Invalid branding response");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 60)
    throw new Error("Invalid platform name");
  if (
    candidate.logoDataUrl !== null &&
    (typeof candidate.logoDataUrl !== "string" ||
      candidate.logoDataUrl.length > 82_000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(candidate.logoDataUrl))
  )
    throw new Error("Invalid platform logo");
  return { name: candidate.name, logoDataUrl: candidate.logoDataUrl } as PlatformBranding;
}
