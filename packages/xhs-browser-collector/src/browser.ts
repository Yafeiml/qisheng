import { type BrowserContext, chromium, type Page } from "playwright-core";
import { browserChannel } from "./browser-channel";
import { captureFirstImageHash } from "./image-hash";
import { readVisibleNote } from "./parser";
import { ensureProfileSafe } from "./profile-preflight";
import {
  allowBrowserRequest,
  blockedDocumentStatus,
  canonicalNoteUrl,
  sameNote,
  validateJobUrl,
} from "./security";
import type { Job, NoteEvidence, NoteReader, Status } from "./types";

export class BrowserNoteReader implements NoteReader {
  private context: BrowserContext | null = null;
  private cancelled = false;

  constructor(
    private readonly profileDirectory: string,
    private readonly beforeNavigation: (job: Job, ordinal: number) => Promise<void>,
  ) {}

  async read(job: Job): Promise<NoteEvidence> {
    validateJobUrl(job.accessUrl);
    if (this.context) throw new Error("BROWSER_BUSY");
    this.cancelled = false;
    let context: BrowserContext | null = null;
    let blocked: Status | null = null;
    const block = (status: Status) => {
      const priority: Partial<Record<Status, number>> = {
        CHALLENGE_REQUIRED: 5,
        RISK_BLOCKED: 5,
        LOGIN_REQUIRED: 4,
        RATE_LIMITED: 4,
        WRONG_TARGET: 3,
        PARTIAL: 2,
        UNAVAILABLE: 2,
      };
      if (!blocked || (priority[status] ?? 0) > (priority[blocked] ?? 0)) blocked = status;
    };
    try {
      await ensureProfileSafe(this.profileDirectory);
      context = await chromium.launchPersistentContext(this.profileDirectory, {
        channel: browserChannel(),
        headless: false,
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      });
      this.context = context;
      if (this.cancelled) return minimal("NETWORK_ERROR");
      // A dedicated Profile is required; never connect to the user's ordinary browser/CDP port.
      for (const tab of context.pages()) await tab.close();
      let imagesRequested = 0;
      let topLevelNavigations = 0;
      let mainPage: Page | null = null;
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();
        const kind = request.resourceType();
        const media = kind === "image";
        let fromMainPage = false;
        let mainDocument = false;
        try {
          fromMainPage = mainPage !== null && request.frame().page() === mainPage;
          mainDocument = fromMainPage && request.frame() === mainPage?.mainFrame();
        } catch {
          // Unknown frames and browser background traffic are never trusted.
        }
        const permitted =
          fromMainPage &&
          allowBrowserRequest(url, kind, job.accessUrl) &&
          (!media || imagesRequested < 12) &&
          (kind !== "document" || mainDocument);
        if (!permitted) {
          if (kind === "document") {
            block(blockedDocumentStatus(url, mainDocument));
          }
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        if (kind === "document" && mainDocument) {
          const ordinal = topLevelNavigations;
          topLevelNavigations += 1;
          try {
            await this.beforeNavigation(job, ordinal);
          } catch {
            block("UNAVAILABLE");
            await route.abort("blockedbyclient").catch(() => undefined);
            return;
          }
        }
        if (media) imagesRequested += 1;
        await route.continue().catch(() => undefined);
      });
      const page = await context.newPage();
      mainPage = page;
      if (this.cancelled) return minimal("NETWORK_ERROR");
      context.on("page", async (popup) => {
        if (popup !== page) await popup.close().catch(() => undefined);
      });
      try {
        await page.goto(job.accessUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page
          .waitForSelector("#detail-title, #detail-desc, .note-detail-container, [role='dialog']", {
            timeout: 8_000,
          })
          .catch(() => undefined);
        await page.waitForTimeout(400);
      } catch (error) {
        if (!blocked) {
          const message = error instanceof Error ? error.message : "";
          if (/Timeout.*exceeded/iu.test(message)) {
            block("TIMEOUT");
          } else if (
            /net::ERR_(?:CONNECTION|DNS|NAME|INTERNET|NETWORK|TIMED_OUT)/iu.test(message)
          ) {
            block("NETWORK_ERROR");
          } else {
            throw new Error("BROWSER_STATE_UNCERTAIN");
          }
        }
      }
      if (blocked && blocked !== "PARTIAL") return minimal(blocked);
      const actual = page.url();
      if (!sameNote(job.accessUrl, actual)) return minimal("WRONG_TARGET");
      const result = await readVisibleNote(page);
      if (
        result.status === "CHALLENGE_REQUIRED" ||
        result.status === "RISK_BLOCKED" ||
        result.status === "LOGIN_REQUIRED" ||
        result.status === "RATE_LIMITED"
      ) {
        return result;
      }
      const images = await captureFirstImageHash(page, result.images ?? []);
      if (blocked) return minimal(blocked);
      return { ...result, images, canonicalUrl: canonicalNoteUrl(actual) };
    } catch (error) {
      if (error instanceof Error && error.message === "BROWSER_BUSY") throw error;
      // Browser launch, routing and page evaluation failures must never become retryable network errors.
      throw new Error("BROWSER_STATE_UNCERTAIN");
    } finally {
      await context?.close().catch(() => undefined);
      this.context = null;
    }
  }

  async close(): Promise<void> {
    this.cancelled = true;
    await this.context?.close();
    this.context = null;
  }
}

function minimal(status: Status): NoteEvidence {
  return { status, observedAt: new Date().toISOString(), visibilityContext: "COLLECTOR_ACCOUNT" };
}
