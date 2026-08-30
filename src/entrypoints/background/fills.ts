import { browser } from 'wxt/browser';
import { getSettings } from '@/lib/platform/settings-store';
import { agentSettings, fillableExclusions } from '@/lib/settings';
import {
  createPersona,
  seededRandom,
  LOCALES,
  type Locale,
} from '@/lib/persona/persona';
import { compileRules } from '@/lib/rules/match';
import { activeProfile, profileName, rulesFor } from '@/lib/profiles';
import { excludedBy } from '@/lib/globs';
import { isFromAgentMessage, type FillScope, type FillTrigger } from '@/lib/protocol';
import type { Operations } from './operations';
import { showBadge, showExcluded } from './badge';
import { trace } from './trace';

/**
 * Fill orchestration: from a trigger to a registered operation (UC-001).
 *
 * Everything here happens once per fill, before any frame is contacted: read
 * the settings, read the tab's address once, decide exclusion and profile,
 * build the persona, compile the rules, and hand the assembled operation to
 * the registry. Extracted from the background entrypoint when it was split;
 * the registry it talks to is passed in, so a test can pass a fake one.
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
export type Target = { readonly tabId: number; readonly frameId?: number | undefined };

/** The top-level frame. A shortcut has no frame of its own to name (see `Target`). */
const TOP_FRAME = 0;

/**
 * The pattern excluding this tab, if any (UC-008).
 *
 * A tab whose URL cannot be read is treated as excluded (UC-008 A1). That is the
 * safe direction and the only one available: the point of the list is that some
 * pages must not be filled, so a fill proceeding because the check could not run
 * is the one failure this must not have.
 */
export type Exclusion =
  /** A pattern the user listed matched this page. The tooltip names it (A4). */
  | { readonly kind: 'pattern'; readonly pattern: string }
  /** UC-008 A1: the address could not be read, so the list could not be checked. */
  | { readonly kind: 'unreadable' };

/**
 * The tab's address, or `undefined` when it cannot be read.
 *
 * Unreadable is the ordinary case rather than an error: `activeTab` is granted
 * by a real user gesture on the tab, so a browser-internal page, a tab the
 * gesture did not reach, or a synthesised trigger all land here.
 *
 * Read here and nowhere else, at the moment the user asks for a fill — which is
 * what `activeTab` grants and what keeps the `tabs` permission off the manifest
 * (BR-008-2, NFR-008). The extension does not watch the user browse, and
 * cannot: without a fill it never learns a single URL.
 */
async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await browser.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

function exclusionFor(url: string | undefined, patterns: readonly string[]): Exclusion | undefined {
  if (patterns.length === 0) {
    // An empty list is the default state of a new install and means the user has
    // excluded nothing — the opposite direction to A1, and deliberately so
    // (UC-008 A2). Checked first so a tab whose URL is unreadable is still
    // fillable when nothing was ever excluded.
    return undefined;
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

/**
 * Starts a fill on one tab.
 *
 * The persona precedes the descriptors (BR-004-1a): it is complete before the
 * page is asked what it contains, which is what lets several frames be filled
 * from one person without coordinating them.
 */
export async function startFill(
  operations: Operations,
  target: Target,
  scope: FillScope,
  trigger: FillTrigger,
): Promise<void> {
  const { tabId } = target;
  if (!operations.claimTab(tabId)) return;
  const operationId = crypto.randomUUID();

  try {
    const settings = await getSettings();

    /**
     * The tab's address, read once for the two things that need it.
     *
     * Hoisted out of `exclusionFor` when profiles arrived, because two readers
     * of one fact must not be two reads: `tabs.get` between them could return
     * different addresses if the tab navigated, and a fill excluded by one page
     * while profiled by another is a state with no correct behaviour.
     */
    const url = await tabUrl(tabId);

    // BR-008-1: before the persona exists and before any frame is contacted. An
    // excluded domain must not be able to observe that the extension exists by
    // being asked a question.
    const exclusion = exclusionFor(url, settings.exclusions.domains);
    if (exclusion !== undefined) {
      trace(`fill in tab ${tabId} refused: ${exclusion.kind === 'pattern' ? exclusion.pattern : 'address unreadable'}`);
      await showExcluded(tabId, exclusion);
      operations.finish(operationId, tabId);
      return;
    }

    /**
     * The profile governing this page, if any (UC-007, UC-017).
     *
     * An unreadable address resolves to no profile, and that is the safe
     * direction: the fill runs with the global rules alone. The alternative —
     * refusing to fill because the profile could not be determined — would make
     * every page whose address we cannot read unfillable the moment a user
     * created their first profile, which is a much larger failure than a fill
     * that used fewer rules than it might have. The report names the profile
     * that applied, so "none" is visible rather than assumed.
     */
    const profile = url === undefined ? undefined : activeProfile(settings.profiles, url);
    const reportedProfile = profile === undefined ? undefined : profileName(profile);
    if (profile !== undefined) trace(`fill in tab ${tabId} using profile "${reportedProfile}"`);

    const seed = Math.floor(Math.random() * 2 ** 32);
    const random = seededRandom(seed);

    operations.register(operationId, {
      // The password policy reaches generation here and nowhere else: the
      // persona holds one password for the whole fill, so a policy applied per
      // field would break UC-006's mirroring rather than configure anything.
      persona: createPersona(random, resolveLocale(settings.locale), settings.passwords),
      random,
      seed,
      tabId,
      outcomes: { filled: 0, skipped: 0, failed: 0 },
      joined: new Set(),
      frames: new Set(),
      started: Date.now(),
      notes: new Map(),
      fields: [],
      scope,
      // The active profile's rules ahead of the global list, first-match-wins
      // doing the rest (FR-031). One ordered list and no second precedence
      // concept, which is what `compileRules` has documented since Phase 2.
      rules: compileRules(rulesFor(profile, settings.rules), settings.sources),
      // The name rather than the profile, because this is what the report
      // shows and nothing downstream needs the rules again (NFR-030's habit:
      // carry the narrowest thing that answers the question).
      //
      // `profileName`, not `profile.label`: a label is optional, and the raw
      // one is `''` for a profile whose URL has been typed and whose name has
      // not. The report folds an empty name into "no profile matched this
      // page" — so until 2026-08-18 a nameless profile ran its rules at top
      // precedence while the report denied it had applied at all. Same
      // fallback the profile list shows, so the two agree.
      profile: reportedProfile,
      defaults: {
        consentKeywords: settings.behaviour.consentKeywords,
        confirmationKeywords: settings.behaviour.confirmationKeywords,
        maxLengths: settings.behaviour.maxLengths,
      },
      skippedRules: new Set(),
      matchCostMs: new Map(),
      excludeCostMs: new Map(),
      // Decided once, here, rather than asked again when the report is built:
      // the settings could have changed under a fill that is still running, and
      // what the report has to name is what *this* fill declined to send.
      skippedExclusions: fillableExclusions(settings.exclusions.fields).refused.map(
        (refusal) => refusal.pattern,
      ),
    });

    // The reply is an acknowledgement from whichever frame answers first, and it
    // is what makes UC-001 A4 decidable. A rejection means no agent received the
    // instruction at all — no content script in this tab, because the page
    // predates the install or the browser forbids acting on it. Without the
    // acknowledgement the resolved value is unspecified: measured on Chrome 151
    // a listener that answers nothing still resolves, with `undefined`, so
    // "nobody is listening" and "everybody heard me" would look identical.
    // Broadcast for the page scope, which is what FR-007 asks for: the operation
    // stays open until every frame that announced itself has reported (see the
    // registry's `complete`) rather than ending on the first, so every frame's
    // outcomes are counted and a frame whose page cascades for seconds is still
    // waited for.
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
    operations.finish(operationId, tabId);
  }
}
