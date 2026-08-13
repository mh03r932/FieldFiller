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
import { classifyStructural, matchesIgnorePattern, radioGroup } from '@/lib/page/exclude';
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

/**
 * Controls this agent wrote, for as long as this page lives.
 *
 * Identity only — a `WeakSet` cannot hold a value even in principle, which is
 * how BR-005-7 is satisfied without touching NFR-010: we remember *which*
 * controls we wrote, never *what* we wrote. Without it, "skip fields that
 * already have content" would silently disable filling the same page twice.
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
        // here: a listener that keeps the port open for the whole walk would
        // block the sender for as long as the page takes.
        sendResponse({ kind: 'accepted', frame: FRAME_ID });
        void fill(message);
      },
    );
  },
});

/**
 * Compiles the ignore patterns once per fill (ND-15, NFR-025).
 *
 * The reference constructs a `RegExp` per element per rule, per fill — 500
 * controls × 100 rules is 50,000 constructions in one run. An invalid pattern is
 * skipped rather than fatal (UC-005 A5): one bad pattern must not stop the other
 * exclusions from being applied.
 */
function compilePatterns(sources: readonly string[]): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      invalid.push(source);
    }
  }
  return { patterns, invalid };
}

/** Every matching source of a control, as the strings patterns are tested against. */
function identityOf(descriptor: FieldDescriptor): string[] {
  // `describe` omits absent sources rather than storing them as undefined, so
  // every value present here is a real string.
  return Object.values(descriptor.sources);
}

async function fill(request: Extract<ToAgentMessage, { kind: 'fill' }>): Promise<void> {
  const { operationId, settings } = request;
  const { patterns, invalid } = compilePatterns(settings.ignorePatterns);

  if (invalid.length > 0) {
    // UC-005 A5: recorded once per fill, not once per field.
    console.warn(`[fieldfiller] ignoring ${invalid.length} invalid ignore pattern(s)`);
  }

  const elements = new Map<number, Element>();
  const descriptors: FieldDescriptor[] = [];
  const outcomes: FieldOutcome[] = [];
  let ref = 0;

  /**
   * One token per actual radio group, assigned here because this is the only
   * side that can resolve real membership: `radioGroup` scopes by the owning
   * form, so two forms using the same `name` get two tokens (BR-005-3). The
   * background keys on the token, and gives every member of a group the same
   * answer.
   */
  const groupTokens = new Map<Element, string>();
  let nextGroup = 0;
  const groupTokenFor = (element: Element): string | undefined => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio') return undefined;

    const existing = groupTokens.get(element);
    if (existing !== undefined) return existing;

    const token = `group-${nextGroup++}`;
    for (const member of radioGroup(element)) groupTokens.set(member, token);
    return token;
  };

  for (const element of collectCandidates(document)) {
    const current = ref++;

    // Structural checks first, so identity is only built for a control that
    // survives them — the ordering UC-005 keeps for cost (BR-005-4).
    const structural = classifyStructural(element, {
      skipHidden: settings.skipHidden,
      skipPreFilled: settings.skipPreFilled,
      writtenByUs,
    });

    if (!structural.fillable) {
      // Recorded, never silently dropped — this is what lets a user tell
      // "nothing to fill" from "everything was ignored" (BR-005-8).
      outcomes.push({ ref: current, status: 'skipped', reason: structural.reason });
      continue;
    }

    const descriptor = describe(element, current, structural.kind, groupTokenFor(element));

    if (patterns.length > 0 && matchesIgnorePattern(identityOf(descriptor), patterns)) {
      outcomes.push({ ref: current, status: 'skipped', reason: 'ignored-pattern' });
      continue;
    }

    elements.set(current, element);
    descriptors.push(descriptor);
  }

  if (descriptors.length > 0) {
    // Wrapped, like every other boundary here. The background may have been
    // evicted, the extension may be mid-reload, and the frame may be navigating
    // — none of which is this frame's failure to handle, but all of which reject
    // and would otherwise surface as an unhandled rejection that loses the whole
    // report.
    let response: unknown;
    try {
      response = await browser.runtime.sendMessage({
        kind: 'descriptors',
        operationId,
        descriptors,
      } satisfies FromAgentMessage);
    } catch (error) {
      response = undefined;
      for (const descriptor of descriptors) {
        outcomes.push({ ref: descriptor.ref, status: 'failed', cause: String(error) });
      }
    }

    if (isValuesResponse(response)) {
      for (const value of response.values) {
        const element = elements.get(value.ref);
        if (element === undefined) continue;

        if (value.as === 'skip') {
          outcomes.push({ ref: value.ref, status: 'skipped', reason: value.reason });
          continue;
        }

        // Per element, so one hostile control cannot end the run (BR-004-11,
        // FR-010). The reference lets a single throw abandon the rest of the
        // page (D10).
        try {
          applyValue(element, value, { dispatchEvents: settings.dispatchEvents });
          writtenByUs.add(element);
          outcomes.push({ ref: value.ref, status: 'filled', provenance: value.provenance });
        } catch (error) {
          outcomes.push({ ref: value.ref, status: 'failed', cause: String(error) });
        }
      }
    }
  }

  try {
    await browser.runtime.sendMessage({
      kind: 'report',
      operationId,
      report: { frame: FRAME_ID, frameUrl: location.href, outcomes },
    } satisfies FromAgentMessage);
  } catch {
    // Nothing left to do with this: the report is the last act of the fill, and
    // the background's own timeout closes an operation whose report never
    // lands. Swallowed deliberately rather than left to reject unhandled.
  }
}
