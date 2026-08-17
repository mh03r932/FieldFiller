import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import { agentSettings } from '@/lib/settings';
import {
  createPersona,
  seededRandom,
  LOCALES,
  type Locale,
  type Persona,
  type Random,
} from '@/lib/persona/persona';
import { generateBatch, tokenRandom } from '@/lib/generators/batch';
import { compileRules, type CompiledRule } from '@/lib/rules/match';
import { excludedBy } from '@/lib/page/scope';
import {
  badgeFor,
  fieldsFromReport,
  noteDescriptors,
  resultSentence,
  type FieldNotes,
} from '@/lib/report/surface';
import {
  isFromAgentMessage,
  type CapReason,
  type FieldReportEntry,
  type FillReport,
  type FillScope,
  type FillTrigger,
  type FromPageMessage,
  type FrameReport,
  type OperationId,
  type ReportResponse,
  type ScopeRefusal,
  type ScopeRule,
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
 * All three trigger channels reach all three scopes as of Phase 3, and a scope
 * produces the same result whichever channel reached it: a channel decides which
 * scopes it can *offer* — the toolbar has no cursor to narrow from — and nothing
 * else (BR-001-6).
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
  /** Which scope was asked for, so the result can say which one ran (DD-006, DD-008). */
  readonly scope: FillScope;
  /**
   * What each frame said its controls were, keyed by frame and ref.
   *
   * Page-derived, and held only for this operation and the one report it
   * produces — `lib/report/surface.ts` states the bound in full.
   */
  readonly notes: FieldNotes;
  /** The per-control rows, accumulated as frames report (FR-009, FR-069). */
  fields: FieldReportEntry[];
  /**
   * The user's rules, compiled once when the fill begins (NFR-025, ND-15).
   *
   * Per operation rather than per batch, because a page with frames sends one
   * batch per frame per pass — compiling per batch would rebuild every pattern
   * on every pass of every frame, which is the cost ND-15 names.
   */
  readonly rules: readonly CompiledRule[];
  /** Rules that could not run, by label, so the user is told (DD-005). */
  readonly skippedRules: Set<string>;
  /** Set when the frame refused to resolve a scope (UC-002 A3, UC-003 A2). */
  refused: ScopeRefusal | undefined;
  /**
   * Which rung of DD-008's ladder resolved the scope (BR-002-4).
   *
   * First frame to report one wins, on the same terms as `refused` below it: a
   * narrowed scope is resolved in one frame — the one the user pointed at — and
   * the others are walking the page scope, which has no rung to name.
   */
  scopeRule: ScopeRule | undefined;
};

type FieldOutcomeCounts = { filled: number; skipped: number; failed: number };

const operations = new Map<OperationId, Operation>();

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

/** Tabs with a fill in progress, so a second invocation is ignored (UC-001 A7). */
const filling = new Set<number>();

/**
 * What the badge on each tab is currently showing, as a counter.
 *
 * A fill's badge reverts after a few seconds; an exclusion mark does not. Without
 * this, the revert timer armed by one fill erases whatever was put there
 * afterwards — fill a page, move to an excluded site inside the revert window,
 * and the "off" mark appears and then silently vanishes. The timer therefore
 * clears only what it set, which it checks by comparing this counter.
 *
 * Found by the scope harness rather than reasoned about: the mark was being set
 * correctly and read back empty.
 */
const badgeGeneration = new Map<number, number>();

function claimBadge(tabId: number): number {
  const next = (badgeGeneration.get(tabId) ?? 0) + 1;
  badgeGeneration.set(tabId, next);
  return next;
}

/**
 * Runs badge writes, and undoes them if the tab moved on while they were in
 * flight (UC-008 A5, BR-008-3).
 *
 * `claimBadge` bumps a generation and the `onUpdated` listener bumps it again on
 * every navigation, clearing the badge as it goes. That ordering was only half
 * honoured: the claim was taken and then never consulted, so a navigation
 * landing between two awaited writes cleared the badge and our next write put
 * the previous page's mark on the newly loaded one.
 *
 * Sub-millisecond, and the next fill re-evaluates from scratch — but the mark
 * claims to stand until the tab navigates, and a mark describing the page before
 * the one on screen is exactly the claim being broken. It matters most for the
 * exclusion mark, which is standing rather than reverted after three seconds:
 * a wrongly-placed `off` says a page is excluded that is not.
 */
async function whileCurrent(tabId: number, generation: number, writes: () => Promise<void>): Promise<void> {
  if (badgeGeneration.get(tabId) !== generation) return;
  await writes();
  if (badgeGeneration.get(tabId) === generation) return;

  await browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  await browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
}

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
/**
 * Which frame a scope is directed at.
 *
 * `undefined` broadcasts to every frame, which is the page scope (FR-007). The
 * narrower scopes go to exactly one frame, because every frame would otherwise
 * resolve the scope against *its own* anchor: a form fill would find no anchor
 * in the sibling frames and widen to their whole documents (UC-002 A2), turning
 * "fill this form" into "fill everything except where you pointed".
 *
 * The context menu supplies the frame it was opened in. A keyboard shortcut has
 * none, so it goes to the top frame, which is where a focused control or the
 * anchorless widening will be found.
 */
type Target = { readonly tabId: number; readonly frameId?: number | undefined };

async function startFill(target: Target, scope: FillScope, trigger: FillTrigger): Promise<void> {
  const { tabId } = target;
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
    const settings = await getSettings();

    // BR-008-1: before the persona exists and before any frame is contacted. An
    // excluded domain must not be able to observe that the extension exists by
    // being asked a question.
    const exclusion = await exclusionFor(tabId, settings.exclusions.domains);
    if (exclusion !== undefined) {
      trace(`fill in tab ${tabId} refused: ${exclusion.kind === 'pattern' ? exclusion.pattern : 'address unreadable'}`);
      await showExcluded(tabId, exclusion);
      filling.delete(tabId);
      return;
    }

    const seed = Math.floor(Math.random() * 2 ** 32);
    const random = seededRandom(seed);

    operations.set(operationId, {
      persona: createPersona(random, resolveLocale(settings.locale)),
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
      scope,
      notes: new Map(),
      fields: [],
      refused: undefined,
      scopeRule: undefined,
      // Profile rules would be concatenated ahead of the global list here, and
      // first-match-wins does the rest (FR-031). Profiles are Phase 5, so today
      // this is the global list alone.
      rules: compileRules(settings.rules, settings.sources),
      skippedRules: new Set(),
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
    // Broadcast for the page scope, which is what FR-007 asks for: the operation
    // stays open until every frame that announced itself has reported (see
    // `complete`) rather than ending on the first, so every frame's outcomes are
    // counted and a frame whose page cascades for seconds is still waited for.
    //
    // Directed for the narrower scopes — see `Target` for why every frame
    // answering would be wrong rather than merely wasteful.
    const addressed =
      scope === 'all-inputs' ? undefined : { frameId: target.frameId ?? TOP_FRAME };

    const acknowledgement: unknown = await browser.tabs.sendMessage(
      tabId,
      {
        kind: 'fill',
        operationId,
        scope,
        trigger,
        settings: agentSettings(settings),
      },
      addressed,
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
 * Which corpus this fill draws from.
 *
 * `auto` follows the browser's own UI language, matched on the language part
 * rather than the whole tag: a browser set to `de` or `de-AT` is closer to the
 * Swiss corpus than to the American one, and matching exactly would send every
 * German-speaking user to en-US for want of a hyphen.
 *
 * Anything unrecognised falls back to the first locale rather than throwing.
 * A person whose browser is in Japanese gets American data, which is wrong but
 * usable; an exception here would mean no fill at all.
 */
function resolveLocale(setting: Locale | 'auto'): Locale {
  if (setting !== 'auto') return setting;

  const language = browser.i18n.getUILanguage().toLowerCase();
  const matched = LOCALES.find((locale) => locale.toLowerCase().startsWith(language.split('-')[0] ?? ''));
  return matched ?? (LOCALES[0] as Locale);
}

/** The top-level frame. A shortcut has no frame of its own to name (see `Target`). */
const TOP_FRAME = 0;

/**
 * The pattern excluding this tab, if any (UC-008).
 *
 * The URL is read here and nowhere else, at the moment the user asks for a fill
 * — which is what `activeTab` grants and what keeps the `tabs` permission off
 * the manifest (BR-008-2, NFR-008). The extension does not watch the user
 * browse, and cannot: without a fill it never learns a single URL.
 *
 * A tab whose URL cannot be read is treated as excluded (UC-008 A1). That is the
 * safe direction and the only one available: the point of the list is that some
 * pages must not be filled, so a fill proceeding because the check could not run
 * is the one failure this must not have.
 */
type Exclusion =
  /** A pattern the user listed matched this page. The tooltip names it (A4). */
  | { readonly kind: 'pattern'; readonly pattern: string }
  /** UC-008 A1: the address could not be read, so the list could not be checked. */
  | { readonly kind: 'unreadable' };

async function exclusionFor(tabId: number, patterns: readonly string[]): Promise<Exclusion | undefined> {
  if (patterns.length === 0) {
    // An empty list is the default state of a new install and means the user has
    // excluded nothing — the opposite direction to A1, and deliberately so
    // (UC-008 A2). Checked first so a tab whose URL is unreadable is still
    // fillable when nothing was ever excluded.
    return undefined;
  }

  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    url = undefined;
  }

  // Kept apart from a real match rather than dressed as one. Substituting a
  // sentence where the pattern goes produced "Filling is off here — this page
  // (its address could not be read) is on your excluded list", which asserts a
  // list entry that does not exist and sends the user looking for it. A1 says
  // the system reports that it could not establish where it was being asked to
  // act, which is a different fact and now has its own message.
  if (url === undefined || url === '') return { kind: 'unreadable' };

  const pattern = excludedBy(url, patterns);
  return pattern === undefined ? undefined : { kind: 'pattern', pattern };
}

/**
 * Marks a tab as excluded (FR-038).
 *
 * Standing, unlike the count a completed fill leaves: a count is about something
 * that happened, and this is about something that will keep not happening. It is
 * cleared when the tab navigates (see the `onUpdated` listener), which needs the
 * tab's identity and its loading state but never its address (BR-008-3).
 */
async function showExcluded(tabId: number, exclusion: Exclusion): Promise<void> {
  const generation = claimBadge(tabId);
  try {
    await whileCurrent(tabId, generation, async () => {
      await browser.action.setBadgeBackgroundColor({ tabId, color: '#6c737f' });
      await browser.action.setBadgeText({ tabId, text: 'off' });
      const title =
        exclusion.kind === 'pattern'
          ? message('resultExcluded', [exclusion.pattern])
          : message('resultExcludedUnreadable');
      await browser.action.setTitle({ tabId, title });
    });
  } catch {
    // A tab that closed cannot show a badge. Not a fill failure.
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

  // Held before the badge is drawn, so the report exists the moment the user
  // could act on seeing it. One fill's worth, in memory, replacing whatever the
  // previous fill left — see `lib/report/surface.ts` on what that permits.
  lastReport = {
    scope: operation.scope,
    finishedAt: Date.now(),
    counts: { ...operation.outcomes },
    capped: operation.capped,
    stale: operation.stale,
    skippedRules: [...operation.skippedRules],
    refused: operation.refused,
    scopeRule: operation.scopeRule,
    fields: operation.fields,
  };

  // BR-001-4: nothing to fill is a success, not a failure, and must be
  // distinguishable from one.
  const badge = badgeFor(operation.outcomes, operation.capped);
  void showBadge(operation.tabId, badge.text, badge.colour, resultTitle(lastReport));
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
  const generation = claimBadge(tabId);
  try {
    await whileCurrent(tabId, generation, async () => {
      await browser.action.setBadgeBackgroundColor({ tabId, color: colour });
      await browser.action.setBadgeText({ tabId, text });
      if (title !== undefined) await browser.action.setTitle({ tabId, title });
    });
    setTimeout(() => {
      // Only if nothing has claimed the badge since. See `badgeGeneration`.
      if (badgeGeneration.get(tabId) !== generation) return;
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
      if (title !== undefined) void browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
    }, 3000);
  } catch {
    // A tab that closed mid-fill cannot show a badge. Not a fill failure.
  }
}

/**
 * The tooltip's sentence (DD-006).
 *
 * Wording is the catalog's (NFR-018) and the choice of *which* sentence is
 * `lib/report`'s, so this is only the join between them. Passing `message`
 * directly is what makes the key list type-safe: a key the sentence builder
 * names and nobody added to `messages.json` fails to compile here.
 */
function resultTitle(report: FillReport): string {
  return resultSentence(report, (key, substitutions) => message(key, substitutions));
}

function isReportRequest(raw: unknown): raw is FromPageMessage {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'report-request';
}

/**
 * Whether a message came from one of this extension's own pages.
 *
 * A content script always has a `tab`; an extension page never does. Combined
 * with the origin check, that distinguishes our options page from an agent
 * running inside a document we do not control — which is the whole reason the
 * report request is not part of `FromAgentMessage`.
 */
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
    // `info.frameId` is the frame the menu was opened in, and it is the whole
    // reason the narrower scopes work from here: it names the document holding
    // the element the user right-clicked (UC-003 A3). Chrome supplies no
    // *element* identifier, which is why the agent has to have seen the click
    // itself — DD-001's argument, restated.
    void startFill({ tabId: tab.id, frameId: info.frameId }, scope, 'menu');
  });

  // FR-004: the toolbar reaches only "fill all inputs" — it has no cursor
  // position to derive a narrower scope from (BR-001-6). It is also the
  // zero-configuration path DD-007 leans on.
  // UC-008 A5. The mark says "this tab is excluded", so it must not outlive the
  // page it was about. This listener is told a tab changed and what state it is
  // in — never what it changed *to* — which is all that clearing needs and is
  // why it costs no permission (BR-008-3).
  browser.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.status !== 'loading') return;
    claimBadge(tabId);
    void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    void browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
  });

  browser.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void startFill({ tabId: tab.id }, 'all-inputs', 'toolbar');
  });

  // The `tab` here is the browser's own argument, not a polyfill's courtesy:
  // Chromium has passed it for years — `@wxt-dev/browser` is generated from
  // `@types/chrome`, which declares `(command, tab?)` — and Firefox added it in
  // 126, under NFR-016's floor of 128. Reading it costs no `tabs` permission,
  // which is the whole reason the shortcut path needs none (NFR-008).
  //
  // It is optional in the signature because a command *can* fire with no tab:
  // a `global` command fires with the browser unfocused. None of ours is
  // declared global (`wxt.config.ts`), so a shortcut only ever arrives with a
  // window focused and an active tab beneath it. The guard below stands anyway
  // — an absent tab leaves nothing to fill and nothing to put a badge on, so
  // returning is the only outcome available rather than a choice.
  browser.commands.onCommand.addListener((command, tab) => {
    const scope = COMMAND_SCOPES[command];
    if (scope === undefined || tab?.id === undefined) return;
    // No frame: a keyboard shortcut is not aimed at anything. The narrower
    // scopes go to the top frame, which resolves them from what is focused there
    // or — for the form scope with nothing focused — by widening (UC-002 A2).
    void startFill({ tabId: tab.id }, scope, 'shortcut');
  });

  // The agent's half of the round trip: descriptors in, values out. Answered
  // with `sendResponse` and an explicit `return true`, which is the one form
  // both browsers agree on for an asynchronous reply.
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // The options page asking for the last report (DD-006). Checked before the
    // agent messages and answered only for our own pages: a content script
    // shares a process with a document we do not control, and the report spans
    // every frame — one frame's agent has no business reading another's.
    if (isReportRequest(raw)) {
      if (!fromExtensionPage(sender)) return;
      sendResponse({ kind: 'report-response', report: lastReport } satisfies ReportResponse);
      return true;
    }

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

      // Recorded before generation, so a control that fails to receive a value
      // still has a name in the report. An agent that predates DD-006 sends no
      // frame token; its rows then join to nothing and say "unknown field",
      // which is the honest outcome rather than attributing them to a frame.
      if (raw.frame !== undefined) {
        noteDescriptors(operation.notes, raw.frame, raw.descriptors);
      }

      const batch = generateBatch(raw.descriptors, {
        persona: operation.persona,
        rules: operation.rules,
        // Per control, derived from the operation's seed and the control's
        // token, so a control the page makes us write twice gets the same value
        // both times (FR-080). An agent from a build before DD-009 sends no
        // token and falls back to the shared stream, which is exactly what it
        // used to get.
        randomFor: (token) =>
          token === undefined ? operation.random : tokenRandom(operation.seed, token),
      });
      for (const note of batch.skippedRules) operation.skippedRules.add(note);
      sendResponse({
        kind: 'values',
        operationId: raw.operationId,
        values: batch.values,
      } satisfies ValuesResponse);
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
    // The counts above and the rows here come from the same outcomes, so the
    // report cannot disagree with the badge about how many fields were filled.
    operation.fields.push(...fieldsFromReport(operation.notes, raw.report));
    // First refusal wins, as the first cap does: a page-scope fill broadcasts to
    // every frame and only the narrow scopes can refuse, so at most one frame
    // ever sets this.
    operation.refused ??= raw.report.refused;
    operation.scopeRule ??= raw.report.scopeRule;

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
