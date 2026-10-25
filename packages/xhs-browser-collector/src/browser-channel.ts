/** Select only a known, locally installed Chromium browser. Never use a model-provided path. */
export function browserChannel(
  configured = process.env.XHS_COLLECTOR_BROWSER_CHANNEL,
  platform = process.platform,
): "chrome" | "msedge" {
  if (!configured) return platform === "win32" ? "msedge" : "chrome";
  const name = configured.trim().toLowerCase();
  if (name === "msedge" || name === "edge") return "msedge";
  if (name === "chrome") return "chrome";
  throw new Error("COLLECTOR_BROWSER_CHANNEL_UNSUPPORTED");
}
