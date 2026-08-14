import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import { agentSettings } from '@/lib/settings';
import { createPersona, seededRandom, type Persona, type Random } from '@/lib/persona/persona';
import { generateBatch } from '@/lib/generators/batch';
import {
  isFromAgentMessage,
  type FillScope,
  type FrameReport,
  type OperationId,
  type ValuesResponse,
} from '@/lib/protocol';

/**
 * Background context — MV3 service worker on Chromium, event page on Firefox
 * (C-003, absorbed by WXT from this one file).
 *
 * It owns the settings, the persona and the generators, and maps every trigger
 * onto a fill. The page agent walks and applies; nothing that carries data
 * crosses into it (DD-003).
 *
 * All three trigger channels reach the page scope (UC-001). The form and
 * single-control scopes are registered on the menu and the commands but not yet
 * implemented — when they land they must produce results identical to the same
 * scope reached any other way, because a channel chooses which scopes it can
 * reach and nothing else (BR-001-6).
 */

const MENU_ITEMS: ReadonlyArray<{ id: FillScope; titleMessage: MessageKey }> = [
  { id: 'all-inputs', titleMessage: 'menuFillAllInputs' },
  { id: 'current-form', titleMessage: 'menuFillCurrentForm' },
  { id: 'selected-input', titleMessage: 'menuFillSelectedInput' },
];

const COMMAND_SCOPES: Readonly<Record<string, FillScope>> = {
  'fill-all-inputs': 'all-inputs',
  'fill-current-form': 'current-form',
  'fill-selected-input': 'selected-input',
};

/**
 * Live fills, by operation id.
 *
 * The persona is created when the fill begins and held only for its lifetime
 * (BR-004-1a). NFR-031 requires generated data to be discarded when the fill
 * completes, so this map is cleared on the report — it is a working set, never a
 * cache, and nothing here is ever written to storage.
 */
type Operation = {
  readonly persona: Persona;
  readonly random: Random;
  readonly tabId: number;
  readonly outcomes: FieldOutcomeCounts;
  /** Frames that have reported, so a duplicate cannot be counted twice. */
  readonly frames: Set<string>;
  /** Abandons the operation if no report ever arrives. */
  timeout: ReturnType<typeof setTimeout>;
  /** Fires once the reports have stopped arriving. */
  settle: ReturnType<typeof setTimeout> | undefined;
};

type FieldOutcomeCounts = { filled: number; skipped: number; failed: number };

const operations = new Map<OperationId, Operation>();

/** Tabs with a fill in progress, so a second invocation is ignored (UC-001 A7). */
const filling = new Set<number>();

function trace(text: string): void {
  if (import.meta.env.COMMAND === 'serve') console.debug(`[fieldfiller] ${text}`);
}

async function registerContextMenus(): Promise<void> {
  try {
    await browser.contextMenus.removeAll();
    for (const item of MENU_ITEMS) {
      browser.contextMenus.create({
        id: item.id,
        title: message(item.titleMessage),
        contexts: ['page', 'editable'],
      });
    }
    trace(`registered ${MENU_ITEMS.length} context menu entries`);
  } catch (error) {
    // `onInstalled` has no error path, and an unhandled rejection here would be
    // reported as an extension error naming no channel. Awaited rather than
    // given a callback because Firefox's `browser.*` is promise-only and
    // validates arguments strictly — the callback form risks leaving every menu
    // silently absent there (NFR-017).
    trace(`context menu registration failed: ${String(error)}`);
  }
}

/**
 * Starts a fill on one tab.
 *
 * The persona precedes the descriptors (BR-004-1a): it is complete before the
 * page is asked what it contains, which is what lets several frames be filled
 * from one person without coordinating them.
 */
async function startFill(tabId: number, scope: FillScope): Promise<void> {
  if (filling.has(tabId)) {
    // UC-001 A7: a second invocation during a running fill is ignored rather
    // than queued. Two overlapping fills would write two personas into one form.
    trace(`fill already running in tab ${tabId}; ignoring`);
    return;
  }
  // Claimed before the first `await`, so a second trigger arriving during the
  // setup is ignored rather than starting a second persona. That claim is only
  // safe because every path out of here releases it — which is why the setup is
  // inside the `try` and not above it. Until `operations` holds the operation
  // there is no timeout to rescue the tab, so a throw between these two points
  // would leave the tab unfillable for as long as the worker lives.
  filling.add(tabId);
  const operationId = crypto.randomUUID();

  try {
    const random = seededRandom(Math.floor(Math.random() * 2 ** 32));
    const settings = await getSettings();

    operations.set(operationId, {
      persona: createPersona(random),
      random,
      tabId,
      outcomes: { filled: 0, skipped: 0, failed: 0 },
      frames: new Set(),
      settle: undefined,
      timeout: setTimeout(() => {
        trace(`fill ${operationId} timed out with no report; abandoning`);
        finish(operationId, tabId);
      }, OPERATION_TIMEOUT_MS),
    });

    // The reply is an acknowledgement from whichever frame answers first, and it
    // is what makes UC-001 A4 decidable. A rejection means no agent received the
    // instruction at all — no content script in this tab, because the page
    // predates the install or the browser forbids acting on it. Without the
    // acknowledgement the resolved value is unspecified: measured on Chrome 151
    // a listener that answers nothing still resolves, with `undefined`, so
    // "nobody is listening" and "everybody heard me" would look identical.
    const acknowledgement: unknown = await browser.tabs.sendMessage(
      tabId,
      {
        kind: 'fill',
        operationId,
        scope,
        settings: agentSettings(settings),
      },
      // No `frameId`: this broadcasts to every frame in the tab, which is what
      // FR-007 asks for. The operation stays open until the reports go quiet
      // (see SETTLE_MS) rather than ending on the first one, so every frame's
      // outcomes are counted and a late frame still receives values.
    );

    if (!isFromAgentMessage(acknowledgement) || acknowledgement.kind !== 'accepted') {
      // Reached the tab, but nothing that speaks this protocol answered — an
      // agent from a previous version of the extension, most likely, still
      // running in a page that has not been reloaded since the update. The fill
      // is left to the timeout rather than cancelled here, because an older
      // agent may still complete it.
      trace(`tab ${tabId} answered the fill without acknowledging it`);
    }
  } catch (error) {
    // Almost always UC-001 A4: no agent in this tab — a page that loaded before
    // the extension was installed, or one the browser does not permit acting on.
    // Reported as its own outcome rather than as a failed fill, because reloading
    // fixes the first and nothing fixes the second. A failure during the setup
    // above lands here too and says the same thing to the user, which is the
    // truth either way: the fill did not run.
    trace(`fill in tab ${tabId} did not start: ${String(error)}`);
    await showBadge(tabId, '—', '#8a8f98');
    finish(operationId, tabId);
  }
}

/**
 * How long an operation may stay open before it is abandoned.
 *
 * A fill ends when its report arrives — but a report is not guaranteed to. If
 * the frame navigates between sending its descriptors and sending its report,
 * nothing ever comes back, and without this the tab stays in `filling` forever:
 * every later fill on that tab is ignored as "already running", and the only
 * cure is the service worker being evicted. An extension that silently stops
 * working until the browser restarts it is worse than one that fails loudly.
 */
const OPERATION_TIMEOUT_MS = 15_000;

/**
 * How long to keep an operation open after its most recent frame report.
 *
 * A page and its frames are one fill (BR-001-1), but nothing tells the
 * background how many frames it reached: `tabs.sendMessage` broadcasts and
 * returns one reply, frames cannot see each other, and asking the browser would
 * need a permission NFR-008 forbids. So completion cannot be decided by counting
 * replies — it is decided by the reports going quiet, with the hard timeout above
 * as the backstop.
 *
 * Short enough that the badge is not visibly late, long enough to cover a frame
 * that is slower than the parent because it is still parsing.
 */
const SETTLE_MS = 400;

/** Ends an operation, discarding the persona and every generated value (NFR-031). */
function finish(operationId: OperationId, tabId: number): void {
  const operation = operations.get(operationId);
  if (operation !== undefined) {
    clearTimeout(operation.timeout);
    if (operation.settle !== undefined) clearTimeout(operation.settle);
  }
  operations.delete(operationId);
  filling.delete(tabId);
}

/**
 * DD-006, provisionally: the count on the badge, then back to nothing.
 *
 * The reference fills silently, so a user cannot tell an empty page from an
 * excluded domain from a crash. A badge is the cheapest way to close that loop
 * and costs the page agent nothing — a toast would put our markup in the user's
 * document and spend bytes against the 40 KB budget.
 *
 * Transient on purpose. The badge is also where the active profile (UC-017) and
 * domain-off (UC-008) indicators will live, and those are persistent facts that
 * must win: a fill count is interesting for a moment, "this domain is excluded"
 * has to be true whenever you look.
 */
async function showBadge(tabId: number, text: string, colour: string): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: colour });
    await browser.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    }, 3000);
  } catch {
    // A tab that closed mid-fill cannot show a badge. Not a fill failure.
  }
}

function summarise(report: FrameReport, counts: FieldOutcomeCounts): void {
  for (const outcome of report.outcomes) {
    // An explicit switch rather than `counts[outcome.status]++`. The status
    // arrives from a page agent that may be a previous version of this
    // extension, so it is a claim rather than a guarantee — and indexing a plain
    // object with an unvalidated string is how `__proto__` and `constructor`
    // find their way into a counter. An unrecognised status is ignored, which is
    // also what makes adding a status a visible change here rather than a
    // silently miscounted one.
    switch (outcome.status) {
      case 'filled':
        counts.filled++;
        break;
      case 'skipped':
        counts.skipped++;
        break;
      case 'failed':
        counts.failed++;
        break;
    }
  }
}


export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void registerContextMenus();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const scope = MENU_ITEMS.find((item) => item.id === info.menuItemId)?.id;
    if (scope === undefined || tab?.id === undefined) return;
    if (scope === 'all-inputs') void startFill(tab.id, scope);
    else trace(`context menu → ${scope} (Phase 3)`);
  });

  // FR-004: the toolbar reaches only "fill all inputs" — it has no cursor
  // position to derive a narrower scope from (BR-001-6). It is also the
  // zero-configuration path DD-007 leans on.
  browser.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void startFill(tab.id, 'all-inputs');
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const scope = COMMAND_SCOPES[command];
    if (scope === undefined || tab?.id === undefined) return;
    if (scope === 'all-inputs') void startFill(tab.id, scope);
    else trace(`command ${command} → ${scope} (Phase 3)`);
  });

  // The agent's half of the round trip: descriptors in, values out. Answered
  // with `sendResponse` and an explicit `return true`, which is the one form
  // both browsers agree on for an asynchronous reply.
  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    // `pong` and `accepted` are replies to something the background asked, not
    // messages it must act on — they arrive through `sendResponse`, not here.
    if (!isFromAgentMessage(raw) || raw.kind === 'pong' || raw.kind === 'accepted') return;

    // An unknown operation id is not an error: the background may have been
    // evicted and restarted since the fill began, taking the persona with it.
    // Nothing to answer with, so nothing is answered.
    const operation = operations.get(raw.operationId);
    if (operation === undefined) return;

    if (raw.kind === 'descriptors') {
      const values = generateBatch(raw.descriptors, operation.persona, operation.random);
      sendResponse({ kind: 'values', operationId: raw.operationId, values } satisfies ValuesResponse);
      return true;
    }

    // One report per frame. A duplicate — a frame that somehow reports twice —
    // must not double the count the user is shown.
    // Keyed on the frame's own token, never its URL. Two iframes with the same
    // `src` are ordinary and every srcdoc frame calls itself `about:srcdoc`,
    // so a URL key discards the second frame's report — its outcomes go
    // uncounted, and since a discarded report does not extend the settle
    // window, a frame slower than SETTLE_MS can have the operation closed
    // before its values arrive.
    if (operation.frames.has(raw.report.frame)) return;
    operation.frames.add(raw.report.frame);
    summarise(raw.report, operation.outcomes);

    // Each frame reports independently and none waits for another
    // (BR-001-5), so the operation closes when the reports stop arriving
    // rather than when any particular one does.
    if (operation.settle !== undefined) clearTimeout(operation.settle);
    operation.settle = setTimeout(() => {
      const { filled, skipped, failed } = operation.outcomes;
      trace(
        `fill ${raw.operationId}: ${filled} filled, ${skipped} skipped, ` +
          `${failed} failed across ${operation.frames.size} frame(s)`,
      );

      // BR-001-4: nothing to fill is a success, not a failure, and must be
      // distinguishable from one.
      void showBadge(
        operation.tabId,
        filled > 0 ? String(filled) : '0',
        failed > 0 ? '#c0392b' : filled > 0 ? '#2f6fed' : '#8a8f98',
      );
      finish(raw.operationId, operation.tabId);
    }, SETTLE_MS);
    return;
  });

  trace('background ready');
});
