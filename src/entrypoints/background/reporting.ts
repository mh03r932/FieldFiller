import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { resultSentence } from '@/lib/report/surface';
import type { FillReport, FromPageMessage, ReportResponse } from '@/lib/protocol';

/**
 * The report half of the background (DD-006): the one fill's worth of report
 * the options page may ask for, and the question it is asked with.
 *
 * Extracted from the background entrypoint when it was split; the seam is that
 * `complete` in the operations registry *produces* a report and this module
 * *holds* it — two different lifetimes, joined by one assignment.
 */

/**
 * The last fill's report, for the options page (DD-006).
 *
 * A module-level variable, deliberately: it lives exactly as long as the
 * background context does, and the background is evicted routinely. That makes
 * "there is no report" an ordinary outcome rather than a failure, and the
 * options page says so in those words.
 *
 * One fill's worth. Assigning here is what discards the previous one, so the
 * window in which page-derived identity exists is bounded by the next fill
 * rather than by anything remembering to clean up (NFR-010, NFR-030).
 */
let lastReport: FillReport | undefined;

/** What `complete` calls when an operation's report is ready to be held. */
export function holdReport(report: FillReport): void {
  lastReport = report;
}

/**
 * The answer to the options page's one question (DD-006).
 *
 * `undefined` report is the ordinary answer — the background holds nothing
 * since it was last evicted — and is sent as itself rather than as an error,
 * because the page has a sentence for exactly that case.
 */
export function reportResponse(): ReportResponse {
  return { kind: 'report-response', report: lastReport };
}

/**
 * The tooltip's sentence (DD-006).
 *
 * Wording is the catalog's (NFR-018) and the choice of *which* sentence is
 * `lib/report`'s, so this is only the join between them. Passing `message`
 * directly is what makes the key list type-safe: a key the sentence builder
 * names and nobody added to `messages.json` fails to compile here.
 */
export function resultTitle(report: FillReport): string {
  return resultSentence(report, (key: MessageKey, substitutions?: readonly string[]) =>
    message(key, substitutions),
  );
}

function isReportRequest(raw: unknown): raw is FromPageMessage {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'report-request';
}

/**
 * Whether a message came from one of this extension's own pages (DD-006).
 *
 * The URL is the whole test, and it has to be: `sender.url` for a content script
 * is the *document's* URL, so a page we do not control cannot present an
 * extension origin here, and one frame's agent still cannot read a report that
 * spans every frame.
 *
 * There used to be a `sender.tab !== undefined` rejection in front of it, meant
 * to exclude content scripts. It excluded the options page instead: Chrome sets
 * `sender.tab` for *anything* sent from a tab, extension pages included, and an
 * options page is a tab — it is how the browser opens one from the extensions
 * screen. So the report request was refused for every real user, the page fell
 * back to its "no report available" text, and that text blames the background
 * being evicted between uses, which is plausible enough that the failure read as
 * the design working. Nothing else asks for a report, so nothing else noticed.
 */
function fromExtensionPage(sender: { tab?: unknown; url?: string | undefined }): boolean {
  return sender.url?.startsWith(browser.runtime.getURL('/')) === true;
}

/**
 * Answers a `report-request` when the message is one and the sender may see the
 * answer. Returns whether the channel is being held for an asynchronous reply.
 */
export function answerReportRequest(
  raw: unknown,
  sender: { tab?: unknown; url?: string | undefined },
  sendResponse: (value: unknown) => void,
): boolean {
  if (!isReportRequest(raw)) return false;
  if (!fromExtensionPage(sender)) return false;
  sendResponse(reportResponse());
  return true;
}
