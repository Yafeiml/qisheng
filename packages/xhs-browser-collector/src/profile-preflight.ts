import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Reduces accidental Chromium tab restore; routing cannot protect the pre-launch window. */
export async function ensureProfileSafe(profileDirectory: string): Promise<void> {
  try {
    const profile = await lstat(profileDirectory);
    if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error("PROFILE_PATH_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const entries = await readdir(profileDirectory);
  if (entries.length === 0) return;
  const preferences = join(profileDirectory, "Default", "Preferences");
  let raw: string;
  try {
    if ((await lstat(join(profileDirectory, "Default"))).isSymbolicLink()) {
      throw new Error("PROFILE_PATH_UNSAFE");
    }
    if ((await lstat(preferences)).isSymbolicLink()) throw new Error("PROFILE_PATH_UNSAFE");
    const size = (await stat(preferences)).size;
    if (size > 16 * 1024 * 1024) throw new Error("PROFILE_PREFERENCES_TOO_LARGE");
    raw = await readFile(preferences, "utf8");
  } catch {
    throw new Error("PROFILE_NOT_CLEANLY_INITIALIZED");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("PROFILE_PREFERENCES_UNREADABLE");
  }
  const profile = parsed.profile as Record<string, unknown> | undefined;
  const session = parsed.session as Record<string, unknown> | undefined;
  if (profile?.exit_type !== "Normal") throw new Error("PROFILE_PREVIOUS_EXIT_UNCLEAN");
  // Only new-tab/unspecified startup policy is tolerated; enterprise policy may still override it.
  if (session?.restore_on_startup !== undefined && session.restore_on_startup !== 5) {
    throw new Error("PROFILE_RESTORE_ENABLED");
  }
}
