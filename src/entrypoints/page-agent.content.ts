import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  isToAgentMessage,
  isValuesResponse,
  type FieldDescriptor,
  type FieldOutcome,
  type FromAgentMessage,
  type ToAgentMessage,
} from '@/lib/protocol';
import { collectCandidates } from '@/lib/page/walk';
import { classify } from '@/lib/page/exclude';
import { describe } from '@/lib/page/identify';
import { applyValue } from '@/lib/page/apply';

/**
 * The page agent — persistently injected into every frame of every page
 * (DD-001), which is what makes NFR-003 the most load-bearing budget in the
 * project: this file's weight is a tax on the user's whole browsing session.
 *
 * It walks, classifies and applies. It carries no corpus, no generators and no
 * persona; those live in the background and reach it as values (DD-003). The
 * import gate enforces that, because the edge that ships an SDK into every page
 * arrives silently (ND-4).
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

        if (message.kind === 'ping') {
          // Answered through `sendResponse`, not by returning a promise:
          // returning a promise from `onMessage` is Firefox-only behaviour, and
          // on Chromium the reply is silently dropped (NFR-017).
          sendResponse({ kind: 'pong', frameUrl: location.href });
          return;
        }

        void fill(message);
      },
    );
  },
});

/**
 * One frame's part in a fill.
 *
 * The frame reports independently and never waits for another (BR-001-1,
 * BR-001-5). Its values come from a persona that already exists in the
 * background, so there is no barrier to coordinate and nothing to time out.
 */
async function fill(request: Extract<ToAgentMessage, { kind: 'fill' }>): Promise<void> {
  const { operationId, settings } = request;

  // Element handles stay in this frame, keyed by the ref the descriptor carries.
  // Nothing about the elements themselves crosses the boundary (NFR-030).
  const elements = new Map<number, Element>();
  const descriptors: FieldDescriptor[] = [];
  const outcomes: FieldOutcome[] = [];
  let ref = 0;

  for (const element of collectCandidates(document)) {
    const current = ref++;
    const classification = classify(element);

    if (!classification.fillable) {
      // Recorded, never silently dropped — this is what lets a user tell
      // "nothing to fill" from "everything was ignored" (BR-005-8).
      outcomes.push({ ref: current, status: 'skipped', reason: classification.reason });
      continue;
    }

    elements.set(current, element);
    descriptors.push(describe(element, current, classification.kind));
  }

  if (descriptors.length > 0) {
    const response: unknown = await browser.runtime.sendMessage({
      kind: 'descriptors',
      operationId,
      descriptors,
    } satisfies FromAgentMessage);

    if (isValuesResponse(response)) {
      for (const { ref: valueRef, value, provenance } of response.values) {
        const element = elements.get(valueRef);
        if (element === undefined) continue;

        // Per element, so one hostile control cannot end the run (BR-004-11,
        // FR-010). The reference lets a single throw abandon the rest of the
        // page (D10).
        try {
          applyValue(element, value, { dispatchEvents: settings.dispatchEvents });
          outcomes.push({ ref: valueRef, status: 'filled', provenance });
        } catch (error) {
          outcomes.push({ ref: valueRef, status: 'failed', cause: String(error) });
        }
      }
    }
  }

  await browser.runtime.sendMessage({
    kind: 'report',
    operationId,
    report: { frameUrl: location.href, outcomes },
  } satisfies FromAgentMessage);
}
