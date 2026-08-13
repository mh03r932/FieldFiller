import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { isToAgentMessage, type FromAgentMessage } from '@/lib/protocol';

/**
 * The page agent — persistently injected into every frame of every page
 * (DD-001), which is what makes NFR-003 the most load-bearing budget in the
 * project: this file's weight is a tax on the user's whole browsing session.
 *
 * Phase 0 answers a liveness probe and nothing else. It exists this early for
 * two reasons: the size gate needs a real bundle to measure rather than a
 * projection, and UC-001 A4 ("the page agent is not present") is only testable
 * against an agent that can be asked.
 *
 * What must never appear in this file or anything it imports: the data corpus,
 * the generators, or any `@faker-js/faker` edge (ND-4, DD-003). Generation runs
 * in the background. `scripts/check-imports.mjs` enforces that.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  // Default `document_idle`. Recording the right-clicked element (Phase 3) does
  // not need an earlier hook — a right-click happens long after idle — and
  // running earlier would spend NFR-005's 15 ms page-load budget for nothing.
  runAt: 'document_idle',

  main() {
    browser.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse: (reply: FromAgentMessage) => void) => {
        if (!isToAgentMessage(message)) return;

        // Answered through `sendResponse`, not by returning a promise. Returning
        // a promise from `onMessage` is Firefox-only behaviour; on Chromium the
        // reply is simply dropped, and the failure is invisible in a
        // Firefox-only test. A synchronous `sendResponse` is the one form both
        // browsers agree on (NFR-017).
        sendResponse({ kind: 'pong', frameUrl: location.href });
      },
    );
  },
});
