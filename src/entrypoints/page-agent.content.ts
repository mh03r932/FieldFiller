import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  isToAgentMessage,
  isValuesResponse,
  type FieldDescriptor,
  type FieldValue,
  type FrameReport,
  type FromAgentMessage,
  type ToAgentMessage,
} from '@/lib/protocol';
import { runFill } from '@/lib/page/fill-loop';
import { resolveScope, watchAnchor } from '@/lib/page/scope';

/**
 * The page agent — persistently injected into every frame of every page
 * (DD-001), which is what makes NFR-003 the most load-bearing budget in the
 * project: this file's weight is a tax on the user's whole browsing session.
 *
 * It is the messaging shell and nothing else. The walk, the classification, the
 * writes and the cascade loop live in `@/lib/page/*`, where they take their DOM
 * root, their clock and their value source as parameters and can be tested
 * without an extension host (NFR-015).
 *
 * It carries no corpus, no generators and no persona; those live in the
 * background and reach it as values (DD-003). The import gate enforces that,
 * because the edge that ships an SDK into every page arrives silently (ND-4).
 */

/**
 * Controls this agent wrote, for as long as this page lives.
 *
 * Identity only — a `WeakSet` cannot hold a value even in principle, which is
 * how BR-005-7 is satisfied without touching NFR-010: we remember *which*
 * controls we wrote, never *what* we wrote. Without it, "skip fields that
 * already have content" would silently disable filling the same page twice.
 *
 * Outlives one fill deliberately, unlike everything the loop allocates.
 */
const writtenByUs = new WeakSet<Element>();

/**
 * This frame's identity, for the life of this agent.
 *
 * A random token rather than `location.href`, because a URL does not identify a
 * frame: two iframes with the same `src` are ordinary, and every srcdoc frame
 * calls itself `about:srcdoc`. The background deduplicates reports on this, and
 * keying that on a URL silently drops the second frame's outcomes.
 */
const FRAME_ID = crypto.randomUUID();

/**
 * Where the user last pointed, for the life of this page (DD-008).
 *
 * Started when the agent loads rather than when a fill begins, because the
 * pointing happens first: a right-click opens the menu, and only then is the
 * scope invoked. Element identity only — never a value — so NFR-010 is
 * untouched (BR-002-5).
 */
const anchors = watchAnchor(document);

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  /**
   * `<all_urls>` does not match `about:srcdoc` or `about:blank`, so without this
   * the agent never reaches a frame written with `srcdoc` or one created empty
   * and populated by script — which is how payment widgets, rich-text editors
   * and a great many embedded forms are built. The frame simply came back
   * unfilled, with nothing to indicate why.
   *
   * Such a frame inherits its parent's origin, so this grants no access the
   * extension does not already have to the containing page.
   */
  matchAboutBlank: true,
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

        // Acknowledged synchronously, before the walk begins. Answering nothing
        // leaves the sender's promise unspecified — measured on Chrome 151 it
        // resolves with `undefined`, which the background cannot tell apart from
        // an agent that ignored the instruction, and nothing guarantees Firefox
        // or a later Chrome behaves the same. The fill itself is not awaited
        // here: a listener that keeps the port open for the whole fill would
        // block the sender for as long as the page takes — and since DD-009 that
        // is seconds rather than milliseconds on a page that cascades.
        sendResponse({ kind: 'accepted', frame: FRAME_ID });
        void fill(message);
      },
    );
  },
});

async function fill(request: Extract<ToAgentMessage, { kind: 'fill' }>): Promise<void> {
  const { operationId, settings } = request;

  // Before anything else, so the background knows this frame is participating
  // even if the walk takes seconds. `accepted` is a reply and only one frame's
  // reply survives the broadcast; this is how the rest are counted.
  try {
    await browser.runtime.sendMessage({
      kind: 'joined',
      operationId,
      frame: FRAME_ID,
    } satisfies FromAgentMessage);
  } catch {
    // The background is gone or reloading. The fill is attempted regardless: if
    // it comes back before the values are needed the fill succeeds, and if not
    // the loop reports every control as failed rather than silently stopping.
  }

  // DD-008. Resolved here, in the frame that saw the pointing — the background
  // knows which frame to ask but not what is inside it.
  const scope = resolveScope(request.scope, document, anchors.anchor(request.trigger));

  if (!scope.resolved) {
    // A refusal is a decision, not an empty fill (UC-002 A3, UC-003 A2), and it
    // is reported as one so the user is told why nothing happened rather than
    // being shown a count of zero.
    await report(operationId, { outcomes: [], refused: scope.reason });
    return;
  }

  const result = await runFill({
    root: document,
    ...('only' in scope ? { only: scope.only } : { within: scope.within }),
    settings,
    writtenByUs,
    requestValues: (descriptors) => requestValues(operationId, descriptors),
  });

  await report(operationId, {
    outcomes: result.outcomes,
    passes: result.passes,
    excludeCostMs: result.excludeCostMs,
    scopeRule: scope.rule,
    ...(result.capped === undefined ? {} : { capped: result.capped, stale: result.stale }),
  });
}

/**
 * Sends this frame's account of the fill.
 *
 * One sender for both endings — a fill that ran and a scope that refused —
 * because a frame that says nothing is indistinguishable from a frame that
 * died, and the background waits out its deadline for it either way.
 *
 * Wrapped, like every boundary here: the report is the last act of the fill, so
 * there is nothing left to do about a failure to send it, and the background's
 * own deadline closes an operation whose report never lands. Swallowed
 * deliberately rather than left to reject unhandled.
 */
async function report(
  operationId: string,
  parts: Omit<FrameReport, 'frame' | 'frameUrl'>,
): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      kind: 'report',
      operationId,
      report: { frame: FRAME_ID, frameUrl: location.href, ...parts },
    } satisfies FromAgentMessage);
  } catch {
    // See above.
  }
}

/**
 * One pass's round trip: descriptors out, values back (DD-003, NFR-029).
 *
 * Wrapped, like every boundary here. The background may have been evicted, the
 * extension may be mid-reload, and the frame may be navigating — none of which
 * is this frame's failure to handle, but all of which reject and would otherwise
 * surface as an unhandled rejection that loses the whole report.
 *
 * A rejection and a reply that is not values are the same event to this frame:
 * no values arrived, so nothing in this pass can be filled. The loop turns that
 * into an outcome for every control in the pass (UC-034 A12).
 */
async function requestValues(
  operationId: string,
  descriptors: readonly FieldDescriptor[],
): Promise<readonly FieldValue[] | undefined> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage({
      kind: 'descriptors',
      operationId,
      // The same token `joined` and `report` carry, so the background can tell
      // whose refs these are (DD-006). Refs are only unique within a frame.
      frame: FRAME_ID,
      descriptors,
    } satisfies FromAgentMessage);
  } catch {
    return undefined;
  }

  return isValuesResponse(response) ? response.values : undefined;
}
