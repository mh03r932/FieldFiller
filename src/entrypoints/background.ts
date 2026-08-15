import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import { agentSettings } from '@/lib/settings';
import { createPersona, seededRandom, type Persona, type Random } from '@/lib/persona/persona';
import { generateBatch, tokenRandom } from '@/lib/generators/batch';
import {
  isFromAgentMessage,
  type CapReason,
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
  /**
   * The operation's seed, kept so that generation can be re-derived per control
   * rather than drawn from a stream (FR-080). New for every fill, which is what
   * keeps values fresh across fills while stable within one (FR-075).
   */
  readonly seed: number;
  readonly tabId: number;
  readonly outcomes: FieldOutcomeCounts;
  /** Frames that said they were participating, and are owed a report. */
  readonly joined: Set<string>;
  /** Frames that have reported, so a duplicate cannot be counted twice. */
  readonly frames: Set<string>;
  /** When the fill began, so the window for frames to join can be closed. */
  readonly started: number;
  /** The last sign of life from any frame, for telling a slow one from a dead one. */
  lastProgress: number;
  /** Abandons the operation if no report ever arrives. */
  timeout: ReturnType<typeof setTimeout>;
  /** Fires once the reports have stopped arriving. */
  settle: ReturnType<typeof setTimeout> | undefined;
  /** Set by the first frame that stops at a bound rather than settling. */
  capped: CapReason | undefined;
  /** How many controls those frames say may be stale (FR-078). */
  stale: number;
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
    const seed = Math.floor(Math.random() * 2 ** 32);
    const random = seededRandom(seed);
    const settings = await getSettings();

    operations.set(operationId, {
      persona: createPersona(random),
      random,
      seed,
      tabId,
      outcomes: { filled: 0, skipped: 0, failed: 0 },
      joined: new Set(),
      frames: new Set(),
      started: Date.now(),
      lastProgress: Date.now(),
      settle: undefined,
      capped: undefined,
      stale: 0,
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
      // FR-007 asks for. The operation stays open until every frame that
      // announced itself has reported (see `complete`) rather than ending on the
      // first one, so every frame's outcomes are counted and a frame whose page
      // cascades for seconds is still waited for.
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
 * How long an operation may stay open with nothing happening before it is
 * abandoned — a sliding deadline, restarted by every sign of progress.
 *
 * A fill ends when its report arrives — but a report is not guaranteed to. If
 * the frame navigates between sending its descriptors and sending its report,
 * nothing ever comes back, and without this the tab stays in `filling` forever:
 * every later fill on that tab is ignored as "already running", and the only
 * cure is the service worker being evicted. An extension that silently stops
 * working until the browser restarts it is worse than one that fails loudly.
 *
 * Sliding rather than a larger fixed figure (DD-009). A cascading page now takes
 * seconds and several round trips, and a fixed timeout long enough for the worst
 * of those would keep the tab locked for just as long after a frame *navigated*
 * mid-fill — making the common failure worse to fix the rare one. Restarting it
 * on each descriptor batch frees a dead agent as quickly as before and never
 * abandons a working one.
 */
const OPERATION_TIMEOUT_MS = 15_000;

/**
 * How long a frame has to say it is participating.
 *
 * A page and its frames are one fill (BR-001-1). `tabs.sendMessage` broadcasts
 * but returns a single reply, frames cannot see each other, and asking the
 * browser which frames exist needs a permission NFR-008 forbids — so each frame
 * says so itself, the moment it takes the instruction up. Every frame that is
 * going to join does so in the same turn as the broadcast; this is generous
 * against a frame still parsing when the instruction arrived.
 */
const JOIN_WINDOW_MS = 300;

/**
 * The backstop for a frame that joined and then stopped existing.
 *
 * A fill now ends when every frame that joined has reported, which is a fact
 * rather than an inference. This covers the one case that leaves: a frame that
 * announced itself and then navigated, so its report is never coming. Longer
 * than the agent's own longest silence mid-fill — one pass's maximum wait for
 * the page to go quiet — so a slow frame is never mistaken for a dead one.
 */
const ABANDON_AFTER_MS = 2500;

/**
 * Closes an operation once every frame that joined has reported.
 *
 * The old rule was "close when reports stop arriving for a while", which was
 * sound while a fill was one walk: every frame reported within milliseconds of
 * the others, so silence really did mean completion. DD-009 broke that — a
 * frame's duration now depends on how much its own page cascades, so two frames
 * in one tab can finish seconds apart. The window that made the badge feel
 * prompt was then also the window that dropped the slower frame's outcomes, and
 * a fill of 33 fields reported 27 with nothing to indicate that anything was
 * missing. Silence and slowness are not distinguishable by waiting longer; they
 * are distinguishable by the frames saying which of the two they are.
 */
function complete(operationId: OperationId): void {
  const operation = operations.get(operationId);
  if (operation === undefined) return;

  const outstanding = [...operation.joined].filter((frame) => !operation.frames.has(frame)).length;
  if (outstanding > 0) {
    const idle = Date.now() - operation.lastProgress;
    if (idle < ABANDON_AFTER_MS) {
      // Measured from the last sign of life, never from the start: a frame in a
      // long cascade is making progress the whole time, and a deadline counted
      // from the trigger would abandon exactly the frames this exists to wait
      // for.
      operation.settle = setTimeout(() => complete(operationId), ABANDON_AFTER_MS - idle);
      return;
    }
    trace(`fill ${operationId}: ${outstanding} frame(s) never reported; closing without them`);
  }

  const { filled, skipped, failed } = operation.outcomes;
  trace(
    `fill ${operationId}: ${filled} filled, ${skipped} skipped, ` +
      `${failed} failed across ${operation.frames.size} frame(s)` +
      (operation.capped === undefined
        ? ''
        : `, capped (${operation.capped}) with ${operation.stale} possibly stale`),
  );

  // BR-001-4: nothing to fill is a success, not a failure, and must be
  // distinguishable from one.
  void showBadge(
    operation.tabId,
    filled > 0 ? String(filled) : '0',
    failed > 0 ? '#c0392b' : filled > 0 ? '#2f6fed' : '#8a8f98',
    capNote(operation),
  );
  finish(operationId, operation.tabId);
}

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
async function showBadge(
  tabId: number,
  text: string,
  colour: string,
  /** FR-078's "and it says that it stopped", where a count cannot say it. */
  title?: string,
): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: colour });
    await browser.action.setBadgeText({ tabId, text });
    if (title !== undefined) await browser.action.setTitle({ tabId, title });
    setTimeout(() => {
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
      if (title !== undefined) void browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
    }, 3000);
  } catch {
    // A tab that closed mid-fill cannot show a badge. Not a fill failure.
  }
}

/**
 * What the badge cannot say (FR-078, DD-006).
 *
 * "6 filled" and "6 filled, 2 may be stale" are different facts about the same
 * page, and a user who cannot tell them apart is back to the reference's problem
 * of not knowing whether anything went wrong. A count has no room for the
 * difference, so it goes in the tooltip — provisionally, exactly as the count
 * itself is provisional. DD-006 is the decision about what replaces both.
 */
function capNote(operation: Operation): string | undefined {
  if (operation.capped === undefined) return undefined;
  const reason =
    operation.capped === 'user-input'
      ? 'stopped because you started typing'
      : operation.capped === 'values-unavailable'
        ? 'stopped: could not reach the extension'
        : 'the page did not settle';
  return `${operation.outcomes.filled} filled — ${reason}, ${operation.stale} field(s) may be stale`;
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
    operation.lastProgress = Date.now();

    if (raw.kind === 'joined') {
      operation.joined.add(raw.frame);
      return;
    }

    if (raw.kind === 'descriptors') {
      // Progress, so the deadline slides. A frame working through a cascade
      // sends one of these per pass, which is what keeps a long fill alive
      // without giving a dead one the same grace.
      clearTimeout(operation.timeout);
      operation.timeout = setTimeout(() => {
        trace(`fill ${raw.operationId} went quiet before reporting; abandoning`);
        finish(raw.operationId, operation.tabId);
      }, OPERATION_TIMEOUT_MS);

      const values = generateBatch(raw.descriptors, {
        persona: operation.persona,
        // Per control, derived from the operation's seed and the control's
        // token, so a control the page makes us write twice gets the same value
        // both times (FR-080). An agent from a build before DD-009 sends no
        // token and falls back to the shared stream, which is exactly what it
        // used to get.
        randomFor: (token) =>
          token === undefined ? operation.random : tokenRandom(operation.seed, token),
      });
      sendResponse({ kind: 'values', operationId: raw.operationId, values } satisfies ValuesResponse);
      return true;
    }

    // One report per frame. A duplicate — a frame that somehow reports twice —
    // must not double the count the user is shown.
    // Keyed on the frame's own token, never its URL. Two iframes with the same
    // `src` are ordinary and every srcdoc frame calls itself `about:srcdoc`,
    // so a URL key discards the second frame's report — and its outcomes go
    // uncounted while the frame it was confused with closes the operation.
    if (operation.frames.has(raw.report.frame)) return;
    operation.frames.add(raw.report.frame);
    summarise(raw.report, operation.outcomes);

    // One frame stopping at a bound caps the whole fill: the user is being told
    // whether this page was settled, and "settled except for that iframe" is not
    // settled (BR-034-6). The first reason wins rather than the last, because a
    // later frame's clean finish must not erase an earlier frame's cap.
    if (raw.report.capped !== undefined) {
      operation.capped ??= raw.report.capped;
      operation.stale += raw.report.stale ?? 0;
    }

    // Each frame reports independently and none waits for another (BR-001-5),
    // so the operation closes when every frame that joined has had its say.
    //
    // Rescheduled rather than fired directly, because a frame can report before
    // a slower sibling has even joined. Nothing is decided until the join window
    // has passed; after that, the check runs the moment a report arrives.
    if (operation.settle !== undefined) clearTimeout(operation.settle);
    operation.settle = setTimeout(
      () => complete(raw.operationId),
      Math.max(0, operation.started + JOIN_WINDOW_MS - Date.now()),
    );
    return;
  });

  trace('background ready');
});
