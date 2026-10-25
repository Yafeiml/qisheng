export function readbackPanelUrl(value: string | null | undefined): URL | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URL parsing silently strips controls.
  if (!value || /[\u0000-\u0020\u007f]/u.test(value) || !/^https?:\/\//u.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      value.includes("@") ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#") ||
      url.pathname !== "/"
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
