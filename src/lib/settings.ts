import {type Locale, LOCALES} from './persona/corpus/corpus';
import type {AgentSettings, ControlKind} from './protocol';
// `validate` imports only *types* back from here, so this is a cycle in the type
// graph and not in the module graph. It is background-side either way: nothing
// in the page agent imports this file, which is what keeps `redos.ts` out of the
// content script (ND-4, and `scripts/check-imports.mjs` enforces it).
import {validateMatcher, type RuleProblem} from './rules/validate';
import {recordOf} from './coerce';

/**
 * The settings state, its defaults, and the coercion that reads it back.
 *
 * Platform-free: this module knows what settings *are*, not where they live.
 * Reading and writing is `lib/platform/settings-store.ts`, which is what keeps
 * the engine testable without a browser host (NFR-015).
 *
 * The whole shape is here — rules, profiles, exclusions, behaviour, password
 * policy and source toggles — even though only the rule model is consumed by
 * the engine today. That is DD-005, resolved 2026-08-15 by being brought forward
 * from Phase 4: the implementation plan states Phase 5 is the last change to the
 * schema and Phase 6 depends on that being true, so defining a section late is
 * more expensive than defining it unused.
 *
 * Storage layout is one item with each section a top-level key, so sharding per
 * section later (which is one of DD-002's options) needs no schema change.
 */

/* ------------------------------------------------------------------ matching */

/**
 * How a rule's pattern is compared against a field's identity (FR-068).
 *
 * Three modes rather than one implicit regex dialect, because the reference's
 * single unanchored-substring behaviour is the source of its worst matching
 * defect: a rule for `name` also fires on `username`, `firstname` and
 * `company_name`, and there is no way to say you meant otherwise.
 *
 * A pattern is never rewritten behind the user's back. `^name$` in `regex` mode
 * means exactly that; `name` in `contains` mode means exactly that. The mode the
 * user picked is the mode that runs, which is what makes UC-013's preview
 * trustworthy.
 */
type MatchMode = 'contains' | 'exact' | 'regex';

/**
 * The identity sources a pattern may be compared against (FR-027, FR-028).
 *
 * Exactly the seven the page agent puts on a descriptor. `autocomplete` is not
 * here: it is a controlled vocabulary rather than free text, and matching a
 * regex against it would invite rules that duplicate what the generator already
 * reads from it directly.
 *
 * `testId` is the test-automation attribute a component-rendered form usually
 * carries — `data-testid` and its five common spellings, resolved to one value
 * by the page agent (FR-083). It is one source rather than a family of them
 * because a control carries one such attribute in practice, and because a
 * separate toggle per spelling would be a settings screen about somebody's
 * house style rather than about matching.
 */
export type MatchSource =
  | 'name'
  | 'id'
  | 'testId'
  | 'className'
  | 'label'
  | 'placeholder'
  | 'ariaLabel';

/**
 * Order is provenance, not precedence (see `selectRule`): a rule whose pattern
 * matches on two sources always reports the same one. `testId` sits beside `id`
 * because that is where it belongs when a reader scans the list, and ahead of
 * it a match is worth reporting — a `data-testid` is a deliberate identity
 * somebody wrote for a machine, where a `class` is usually a side effect.
 */
export const MATCH_SOURCES: readonly MatchSource[] = [
  'name',
  'id',
  'testId',
  'className',
  'label',
  'placeholder',
  'ariaLabel',
];

/**
 * One pattern and how to apply it.
 *
 * Matching is case-insensitive in every mode, and that is deliberate rather than
 * an omission: field identities are authored by whoever wrote the page, in
 * whatever convention they used, and a rule that works on `firstName` but not
 * `firstname` is a bug report waiting to happen. A user who needs case to matter
 * can express it in `regex` mode with an explicit character class.
 */
export type Matcher = {
  readonly mode: MatchMode;
  readonly pattern: string;
};

/* ---------------------------------------------------------------- generators */

/**
 * What a matched rule produces — ND-9's correction, as a discriminated union.
 *
 * The reference carries one `template: string` across four unrelated grammars
 * (a telephone mask, a moment-style date format, an alphanumeric template and a
 * regex), discriminated only by `type` and validated nowhere. Its own importer
 * cannot tell a malformed regex from a valid date format. Here each type
 * declares its own options, so an invalid one is a type error before it is ever
 * a validation error.
 *
 * Thirteen types: the twelve FR-019 names for parity with the reference, plus
 * `constant` — the most common real need, which otherwise has to be spelled as a
 * randomized list of length one.
 */
export type Generator =
  | { readonly type: 'name'; readonly part: NamePart }
  | { readonly type: 'email' }
  | { readonly type: 'username' }
  | { readonly type: 'organisation' }
  | { readonly type: 'telephone' }
  | { readonly type: 'url' }
  | { readonly type: 'number'; readonly min: number; readonly max: number; readonly decimals: number }
  | { readonly type: 'date'; readonly format: string; readonly from: string; readonly to: string }
  | { readonly type: 'text'; readonly minWords: number; readonly maxWords: number }
  | { readonly type: 'alphanumeric'; readonly template: string }
  | { readonly type: 'regex'; readonly pattern: string }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'constant'; readonly value: string };

type NamePart = 'full' | 'first' | 'last';

/** The generator types that have a persona counterpart to draw from. */
export const PERSONA_BACKED: ReadonlySet<Generator['type']> = new Set([
  'name',
  'email',
  'username',
  'organisation',
  'telephone',
  'url',
]);

/* --------------------------------------------------------------------- rules */

export type Rule = {
  readonly id: string;
  /** What the user calls it. Shown in the report as a value's provenance (FR-069). */
  readonly label: string;
  readonly enabled: boolean;
  readonly match: Matcher;
  /**
   * The sources this rule matches against (FR-067).
   *
   * `undefined` means "whatever is enabled globally", which is what keeps an
   * ordinary rule short. The effective set is always the intersection with the
   * global toggles, so turning `className` off in one place silences the noisiest
   * source everywhere without editing a single rule.
   */
  readonly sources?: readonly MatchSource[] | undefined;
  readonly generator: Generator;
  /**
   * Whether a persona-backed generator draws from this fill's persona (ND-1) or
   * generates freshly.
   *
   * Defaults to `true` for a new rule, so a rule written without thinking about
   * this keeps the record coherent: the email a rule writes still matches the
   * one the page's own confirmation field and summary show. Breaking coherence
   * is something the user opts into.
   *
   * Ignored by generators with no persona counterpart — there is nothing
   * coherent about an alphanumeric template.
   */
  readonly fromPersona: boolean;
};

/* ------------------------------------------------------------------ profiles */

/**
 * A named rule set that applies to some pages (Phase 5, UC-014..UC-017).
 *
 * URLs are glob patterns — `*.staging.example.com/*` — rather than regexes. The
 * vocabulary is the one users already know from extension match patterns, it is
 * cheap to validate, and it keeps a second catastrophic-backtracking surface off
 * the path that runs on every page load, which is exactly where NFR-009 is
 * hardest to guarantee.
 */
export type Profile = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly urls: readonly string[];
  readonly rules: readonly Rule[];
};

/* ---------------------------------------------------------------- exclusions */

type Exclusions = {
  /** UC-005 step 5, UC-020. Carries the same match modes rules do. */
  readonly fields: readonly Matcher[];
  /** UC-008, UC-021, FR-074. Glob patterns, as profiles use. */
  readonly domains: readonly string[];
};

/* ----------------------------------------------------------------- behaviour */

export type Behaviour = {
  /** UC-004 A8. Off means values are written without the interaction sequence. */
  readonly dispatchEvents: boolean;
  /** UC-005 step 6. On by default: filling a honeypot is what FR-071 exists to prevent. */
  readonly skipHidden: boolean;
  /**
   * UC-005 step 7. Off by default, because the common case is filling a form
   * repeatedly with fresh data (FR-075) — and our own earlier writes never count
   * as content either way (BR-005-7).
   */
  readonly skipPreFilled: boolean;
  /**
   * Per-control-type length caps, applied only where the control itself declares
   * no `maxlength` (FR-065, ND-10).
   *
   * Empty by default, so the built-in sizing — a paragraph for a textarea, a
   * phrase for a text input — is what runs unless the user asks otherwise. The
   * reference's single global `defaultMaxLength: 20` is the defect this replaces:
   * it gives an unconstrained textarea twenty characters.
   *
   * The page still wins. A control declaring its own `maxlength` is constrained
   * by that and never by this, because a value the page's own validation rejects
   * is useless whatever the user configured (ND-11, FR-072's argument restated
   * for lengths).
   */
  readonly maxLengths: Partial<Record<ControlKind, number>>;
  /**
   * Words that mark a checkbox as a consent gate, so it is always ticked
   * (FR-015, UC-022).
   *
   * Configurable because the vocabulary is per-market and per-product: a German
   * form says `einwilligung`, and a user testing one should not have to write a
   * rule per form to get past its terms gate. Matched case-insensitively against
   * every identity source, as a literal substring — the strings are escaped
   * before they are compiled, so a keyword cannot become a regex by accident and
   * this list adds no backtracking surface (NFR-009).
   *
   * An empty list means no checkbox is ever ticked *for being consent*. Required
   * ones still are, which is a separate rule and is not configurable: an unticked
   * required box blocks the submission the fill exists to reach.
   */
  readonly consentKeywords: readonly string[];
  /**
   * Words that mark a field as confirming an earlier one (FR-024, UC-006).
   *
   * Same matching as the consent list, and the same reason to be configurable.
   *
   * It is only the *words*. A trailing ordinal — `password2` beside `password` —
   * also marks a confirmation, and that rule stays in the generator rather than
   * appearing here as a keyword the user could delete: it is a convention about
   * shape, not a word, and expressing it as one would need the anchors this list
   * deliberately escapes away. `docs/use_cases/UC-022.md` states the split so the
   * screen is not read as offering more control than it has.
   */
  readonly confirmationKeywords: readonly string[];
};

/* ------------------------------------------------------------------ triggers */

/**
 * Which ways of invoking a fill are available (FR-050, UC-023).
 *
 * One field, and the two absent ones are the decision. The toolbar button
 * carries no setting because it is the zero-configuration path (BR-023-2):
 * removing it would let a user delete the only route that needs no setup, from a
 * screen they may not find their way back to. Keyboard bindings carry none
 * because no extension can set them — only the browser can, and UC-023's surface
 * routes there rather than pretending otherwise (BR-023-1).
 */
type Triggers = {
  readonly contextMenu: boolean;
};

/* ------------------------------------------------------------------ passwords */

/**
 * The policy a `password` rule starts from (FR-025).
 *
 * Whatever this produces is still fitted to the field's own `pattern`,
 * `minlength` and `maxlength` before it is written (FR-072). Policy loses to the
 * page, always — a password the registration form rejects is ND-11 restated.
 */
export type PasswordPolicy = {
  readonly length: number;
  readonly upper: boolean;
  readonly lower: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
};

/* ------------------------------------------------------------------ settings */

export type SourceToggles = Record<MatchSource, boolean>;

export type Settings = {
  /**
   * Schema version. Present from the first release even though there is nothing
   * to migrate yet: a stored state with no version is indistinguishable from
   * version 1, and the first migration is the one that discovers this.
   *
   * DD-005 chose a tolerant parser over a migration ladder, so this field is
   * currently a marker rather than a switch. It stays because it is what makes
   * adding a ladder later possible without changing the stored shape — and the
   * moment to add one is any change that restructures a section, because the
   * parser below will silently drop what it cannot recognise.
   */
  readonly version: 1;
  /**
   * Which corpus a fill draws from (ND-1).
   *
   * `auto` follows the browser's own UI language, which is the closest thing to
   * an answer the extension can have without asking: a tester's browser is
   * usually configured for the market they build for. An explicit locale
   * overrides it, because the two do diverge — a Swiss developer whose browser
   * is in English is testing Swiss forms.
   *
   * Resolved in the background, never here: this module knows what settings
   * *are*, and the browser's language is a platform fact (NFR-015).
   */
  readonly locale: Locale | 'auto';
  readonly rules: readonly Rule[];
  readonly profiles: readonly Profile[];
  readonly exclusions: Exclusions;
  readonly behaviour: Behaviour;
  readonly passwords: PasswordPolicy;
  /** FR-028. Which identity sources any rule may match against at all. */
  readonly sources: SourceToggles;
  /** FR-050. Which invocation methods are offered. */
  readonly triggers: Triggers;
};

/**
 * `className` ships off and everything else ships on (BR-018-2).
 *
 * `testId` ships on with the rest. It is the opposite of `className` on the one
 * axis that decided that switch: the attribute exists only where somebody put it
 * there on purpose, so on a page without test ids the source is absent rather
 * than noisy, and on a page with them it is the most reliable identity present.
 */
export const DEFAULT_SOURCES: SourceToggles = {
  name: true,
  id: true,
  testId: true,
  className: false,
  label: true,
  placeholder: true,
  ariaLabel: true,
};

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  length: 16,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
};

/**
 * What `parseSettings` will accept as a password length.
 *
 * Named here so the screen that edits it and the parser that stores it cannot
 * hold different bounds. They did: the control had none at all, so a length of 0
 * lived happily in the options page's memory while storage held the clamped
 * value — and because this page decides whose write a change was by comparing
 * `parseSettings(memory)` with storage, the clamp came back looking like its own
 * work and was never adopted. The screen's sample and the next fill then
 * disagreed until a reload.
 *
 * The floor is 1 because a zero-length password is the empty string, which no
 * field wants and every `required` field rejects. The ceiling is arbitrary and
 * generous: it is a bound against nonsense, not a policy.
 */
export const PASSWORD_LENGTH: { readonly min: number; readonly max: number } = { min: 1, max: 256 };

/**
 * What `parseSettings` will accept from the numeric generator forms, for the
 * same reason `PASSWORD_LENGTH` is here: the control and the parser must not
 * hold different answers.
 *
 * Bounds only. The parser *also* orders `min` against `max` and `minWords`
 * against `maxWords`, and that stays where it is — a pair of boxes cannot
 * express "this one must not exceed the other one" while either is being typed,
 * and `validateGenerator` is what tells the user when they have crossed
 * (FR-070). These are the limits each box can state on its own.
 */
export const GENERATOR_BOUNDS = {
  /** Wide enough not to be a policy, finite enough to keep `Infinity` out. */
  number: { min: -1e15, max: 1e15 },
  /** `toFixed` throws above 100; ten is past any plausible form field. */
  decimals: { min: 0, max: 10 },
  /** A word count, so at least one — and a filler paragraph, not a novel. */
  words: { min: 1, max: 500 },
} as const;

/**
 * The shipped consent vocabulary (FR-015).
 *
 * English only, because it is what the reference page and the great majority of
 * forms use, and because a list nobody edits is better short than speculative.
 * UC-022's screen is how a user testing German or French forms adds theirs.
 */
export const DEFAULT_CONSENT_KEYWORDS: readonly string[] = [
  'terms',
  'conditions',
  'privacy',
  'policy',
  'agree',
  'accept',
  'consent',
  'gdpr',
];

/** The shipped confirmation vocabulary (FR-024). The ordinal rule is not here. */
export const DEFAULT_CONFIRMATION_KEYWORDS: readonly string[] = [
  'confirm',
  'verify',
  'repeat',
  'retype',
  'again',
];

const DEFAULT_TRIGGERS: Triggers = {
  // On, because the context menu is the only channel that can reach the narrower
  // scopes with a cursor to derive them from (BR-001-6). Shipping it off would
  // make two of the three scopes unreachable until the user found this screen.
  contextMenu: true,
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  locale: 'auto',
  // Empty on purpose. An unmatched field falls through to the persona-driven
  // generator, so a user who writes no rules gets exactly the engine that
  // shipped before rules existed (DD-005).
  rules: [],
  profiles: [],
  exclusions: { fields: [], domains: [] },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: false,
    maxLengths: {},
    consentKeywords: DEFAULT_CONSENT_KEYWORDS,
    confirmationKeywords: DEFAULT_CONFIRMATION_KEYWORDS,
  },
  passwords: DEFAULT_PASSWORD_POLICY,
  sources: DEFAULT_SOURCES,
  triggers: DEFAULT_TRIGGERS,
};

/**
 * The subset an agent needs (BR-024-4).
 *
 * A function rather than a spread so that adding a setting the background alone
 * uses cannot leak into the page by default — the boundary has to be crossed
 * deliberately, one field at a time.
 *
 * Field exclusions cross it as regex *source strings*, not as matchers. The page
 * agent has understood one vocabulary since UC-005 and there is no reason to
 * teach it three: translating `contains` and `exact` into anchored, escaped
 * patterns here costs the background nothing and keeps NFR-003's 40 KB budget
 * spent on filling rather than on parsing settings.
 */
export function agentSettings(settings: Settings): AgentSettings {
  return {
    dispatchEvents: settings.behaviour.dispatchEvents,
    skipHidden: settings.behaviour.skipHidden,
    skipPreFilled: settings.behaviour.skipPreFilled,
    ignorePatterns: fillableExclusions(settings.exclusions.fields).runnable.map(patternSource),
  };
}

/** A field exclusion that will not be sent to a page, and the fault that stopped it. */
type RefusedExclusion = { readonly pattern: string; readonly problem: RuleProblem };

/**
 * Which field exclusions a page may evaluate, and which this build will not ask
 * it to (NFR-009, UC-005 A5, UC-026 A8).
 *
 * *Stored* and *run* are different questions, and until 2026-08-24 only the
 * first had an answer. The exclusion editor stores a pattern while it is still
 * being typed, on purpose, and an import stores one out of a file and names it
 * rather than refusing it — both right, and neither a reason to hand the pattern
 * to a page. `matchesIgnorePattern` tests every stored pattern against every
 * source of every control on every pass, and the sources are the page's:
 * `className` verbatim, the joined label text. A pattern the editor already
 * flags as catastrophic met that input and hung the tab.
 *
 * Measured on 2026-08-24, `^(\s*[\w-]+)+$` — a shape a shared configuration
 * could plausibly carry — against ordinary utility class strings:
 *
 *   6 classes /  30 chars      18 ms
 *   8 classes /  40 chars     287 ms
 *   9 classes /  45 chars     2.3 s
 *  10 classes /  50 chars    18.9 s
 *  16 classes /  86 chars    55.7 s
 *
 * That is one call, for one control. Note where those inputs sit: NFR-032 asks
 * for identity to be truncated to 1,024 characters, and every row above is an
 * order of magnitude *under* that bound. Truncation is worth having and it would
 * not have prevented any of this — backtracking is exponential in length, so a
 * cut only helps below the cliff, and the cliff here is about 40 characters,
 * which is shorter than a great many honest labels. The 250 ms budget cannot
 * pre-empt an overrun either; it decides whether to start the *next* pattern,
 * 55 seconds later.
 *
 * So the containment is here, before the page is involved at all: a pattern
 * `validateMatcher` refuses is not sent. The information was always available —
 * the same function draws the warning beside the field in the exclusion editor —
 * and the fill path simply never asked.
 *
 * Refused, never silently dropped. The caller reports what was left out, because
 * an exclusion that does not run is a field the user asked to be left alone and
 * that gets filled anyway (BR-005-6's habit: a skip is visible or it is a bug).
 *
 * Here rather than in the agent because the agent stays thin (NFR-003, ND-4):
 * `validateMatcher` reaches `redos.ts` and `regex-subset.ts`, and the background
 * already has them. The agent keeps its own `try`/`catch` around compilation as
 * a backstop, which is where an uncompilable pattern was already stopping.
 */
export function fillableExclusions(fields: readonly Matcher[]): {
  readonly runnable: readonly Matcher[];
  readonly refused: readonly RefusedExclusion[];
} {
  const runnable: Matcher[] = [];
  const refused: RefusedExclusion[] = [];

  for (const matcher of fields) {
    const problem = validateMatcher(matcher)[0];
    if (problem === undefined) runnable.push(matcher);
    else refused.push({ pattern: matcher.pattern, problem });
  }

  return { runnable, refused };
}

/**
 * One matcher as a regular expression source string.
 *
 * Exported because rule matching uses it too: one translation, so a `contains`
 * exclusion and a `contains` rule cannot drift into meaning different things.
 */
export function patternSource(matcher: Matcher): string {
  switch (matcher.mode) {
    case 'exact':
      return `^${escapeRegex(matcher.pattern)}$`;
    case 'contains':
      return escapeRegex(matcher.pattern);
    case 'regex':
      return matcher.pattern;
  }
}

/** Every character with a meaning inside a pattern, made literal. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------- parsing */

/**
 * Coerces stored data into a valid settings state.
 *
 * Storage is the source of truth (BR-024-3), but it is not trustworthy: it may
 * hold a state written by an older version, or nothing at all on first run.
 * Unknown or malformed input falls back to defaults per field rather than
 * rejecting the whole state, so one bad key cannot leave the user with no
 * settings at all — and there is no way to load a state unmigrated, which is
 * ND-13's bypass closed.
 *
 * A malformed *rule* is dropped rather than defaulted, because there is no
 * sensible default for "what should this rule have generated" — and a rule
 * silently repaired into something the user did not write is worse than one that
 * is visibly missing.
 */
export function parseSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;

  const candidate = stored as Record<string, unknown>;
  const behaviour = recordOf(candidate['behaviour']);
  const exclusions = recordOf(candidate['exclusions']);
  const passwords = recordOf(candidate['passwords']);
  const sources = recordOf(candidate['sources']);

  return {
    version: 1,
    locale: parseLocale(candidate['locale']),
    rules: parseRules(candidate['rules']),
    profiles: parseProfiles(candidate['profiles']),
    exclusions: {
      fields: parseMatchers(exclusions['fields'] ?? candidate['ignorePatterns']),
      domains: globs(exclusions['domains'], DEFAULT_SETTINGS.exclusions.domains),
    },
    behaviour: {
      // `?? candidate[...]` reads the pre-DD-005 flat shape, where these three
      // sat at the top level. It is the one structural change the tolerant
      // parser is asked to survive, and it is cheap because the leaves did not
      // move — only their parent did.
      dispatchEvents: boolean(
        behaviour['dispatchEvents'] ?? candidate['dispatchEvents'],
        DEFAULT_SETTINGS.behaviour.dispatchEvents,
      ),
      skipHidden: boolean(
        behaviour['skipHidden'] ?? candidate['skipHidden'],
        DEFAULT_SETTINGS.behaviour.skipHidden,
      ),
      skipPreFilled: boolean(
        behaviour['skipPreFilled'] ?? candidate['skipPreFilled'],
        DEFAULT_SETTINGS.behaviour.skipPreFilled,
      ),
      maxLengths: parseMaxLengths(behaviour['maxLengths']),
      // An *empty* stored list stays empty rather than falling back to the
      // shipped words: "tick nothing for consent" is a configuration a user can
      // choose, and `strings` returns the default only when the key is absent or
      // is not a list at all. Defaulting an emptied list would make the screen's
      // last removal silently undo itself on the next load.
      consentKeywords: keywords(behaviour['consentKeywords'], DEFAULT_CONSENT_KEYWORDS),
      confirmationKeywords: keywords(
        behaviour['confirmationKeywords'],
        DEFAULT_CONFIRMATION_KEYWORDS,
      ),
    },
    passwords: {
      length: integer(
        passwords['length'],
        DEFAULT_PASSWORD_POLICY.length,
        PASSWORD_LENGTH.min,
        PASSWORD_LENGTH.max,
      ),
      upper: boolean(passwords['upper'], DEFAULT_PASSWORD_POLICY.upper),
      lower: boolean(passwords['lower'], DEFAULT_PASSWORD_POLICY.lower),
      digits: boolean(passwords['digits'], DEFAULT_PASSWORD_POLICY.digits),
      symbols: boolean(passwords['symbols'], DEFAULT_PASSWORD_POLICY.symbols),
    },
    sources: parseSources(sources),
    triggers: {
      contextMenu: boolean(recordOf(candidate['triggers'])['contextMenu'], DEFAULT_TRIGGERS.contextMenu),
    },
  };
}

/**
 * A keyword list, trimmed and emptied of blanks.
 *
 * Blank entries are dropped rather than kept, because a keyword of `''` is a
 * substring of every identity: one stray blank line in the textarea that edits
 * this list would tick every checkbox on every page, and it would look like
 * nothing at all on screen. Trimming is the same argument one step earlier — a
 * keyword with a trailing space matches nothing and reads as though it should.
 */
function keywords(stored: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(stored)) return fallback;
  return stored
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function parseLocale(stored: unknown): Locale | 'auto' {
  if (stored === 'auto') return 'auto';
  return (LOCALES as readonly string[]).includes(stored as string) ? (stored as Locale) : 'auto';
}

function parseSources(stored: Record<string, unknown>): SourceToggles {
  const toggles: Record<string, boolean> = {};
  for (const source of MATCH_SOURCES) {
    toggles[source] = boolean(stored[source], DEFAULT_SOURCES[source]);
  }
  return toggles as SourceToggles;
}

function parseMaxLengths(stored: unknown): Partial<Record<ControlKind, number>> {
  if (typeof stored !== 'object' || stored === null) return {};

  const caps: Partial<Record<ControlKind, number>> = {};
  for (const [kind, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      caps[kind as ControlKind] = value;
    }
  }
  return caps;
}

/**
 * Field exclusions, from either shape.
 *
 * A bare string is the pre-DD-005 `ignorePatterns` entry, which was a regex
 * source — so it is lifted as `regex` mode rather than `contains`. Reading it as
 * `contains` would change what a stored pattern means, quietly, on upgrade.
 */
function parseMatchers(stored: unknown): readonly Matcher[] {
  if (!Array.isArray(stored)) return [];

  const matchers: Matcher[] = [];
  for (const entry of stored) {
    if (typeof entry === 'string') {
      matchers.push({ mode: 'regex', pattern: entry });
      continue;
    }
    const matcher = parseMatcher(entry);
    if (matcher !== undefined) matchers.push(matcher);
  }
  return matchers;
}

function parseMatcher(stored: unknown): Matcher | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;

  const candidate = stored as Record<string, unknown>;
  const pattern = candidate['pattern'];
  const mode = candidate['mode'];
  if (typeof pattern !== 'string' || pattern === '') return undefined;
  if (mode !== 'contains' && mode !== 'exact' && mode !== 'regex') return undefined;

  return { mode, pattern };
}

function parseRules(stored: unknown): readonly Rule[] {
  if (!Array.isArray(stored)) return [];

  const rules: Rule[] = [];
  // The position is carried in because the id fallback needs it — see
  // `parseRule`. It is the entry's place in the file, so a rule the parser could
  // not read leaves a gap in the numbering rather than shifting every rule after
  // it: the alternative renumbers survivors according to what was *dropped*,
  // which is a worse thing for an id to depend on.
  for (const [index, entry] of stored.entries()) {
    const rule = parseRule(entry, index);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
}

function parseRule(stored: unknown, index: number): Rule | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;

  const candidate = stored as Record<string, unknown>;
  const match = parseMatcher(candidate['match']);
  const generator = parseGenerator(candidate['generator']);
  if (match === undefined || generator === undefined) return undefined;

  const sources = parseSourceList(candidate['sources']);
  return {
    // A rule that states no `id` is given one made from its pattern *and its
    // position*, because the pattern alone is not unique and every editor write
    // is keyed on the id. Two rules matching `email` in a hand-written file
    // arrived carrying the same one, and `replaceRule` maps *all* matches while
    // `removeRule` filters all: editing one relabelled both, deleting one
    // deleted both. Fills never noticed — matching walks the list in order and
    // takes the first hit — which is exactly why it survived to be found by
    // review rather than by use.
    //
    // Position is enough here and no more than enough. It is unique within the
    // list it was read from, and stable across reads of the same stored state,
    // which is what an id has to be. A file that *repeats* an explicit id still
    // collides: that is a file saying two entries are the same rule, and a
    // parser that quietly renamed one would be overruling the file rather than
    // reading it. The importer is where a file's own contradictions get named.
    id: typeof candidate['id'] === 'string' ? candidate['id'] : `${match.pattern}#${index}`,
    label: typeof candidate['label'] === 'string' ? candidate['label'] : match.pattern,
    enabled: boolean(candidate['enabled'], true),
    match,
    ...(sources === undefined ? {} : { sources }),
    generator,
    // Defaults to drawing from the persona (DD-005): a rule stored without the
    // flag — an imported one, or one written before it existed — keeps ND-1's
    // coherent record rather than quietly breaking it.
    fromPersona: boolean(candidate['fromPersona'], true),
  };
}

function parseSourceList(stored: unknown): readonly MatchSource[] | undefined {
  if (!Array.isArray(stored)) return undefined;

  // An empty list after filtering means the rule named only sources we do not
  // have. That is not the same as naming none, so it is not collapsed to
  // `undefined` — the rule matches nothing, visibly, rather than silently
  // widening to every source.
  return stored.filter((entry): entry is MatchSource =>
          typeof entry === 'string' && (MATCH_SOURCES as readonly string[]).includes(entry),
  );
}

function parseProfiles(stored: unknown): readonly Profile[] {
  if (!Array.isArray(stored)) return [];

  const profiles: Profile[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const id = candidate['id'];
    if (typeof id !== 'string') continue;

    profiles.push({
      id,
      label: typeof candidate['label'] === 'string' ? candidate['label'] : id,
      enabled: boolean(candidate['enabled'], true),
      urls: globs(candidate['urls'], []),
      rules: parseRules(candidate['rules']),
    });
  }
  return profiles;
}

/**
 * One generator, or `undefined` if it cannot be read.
 *
 * Every branch names its own options, which is the point of ND-9's union: a
 * `date` with a `pattern` and no `format` is not a slightly wrong date
 * generator, it is not a date generator at all.
 */
function parseGenerator(stored: unknown): Generator | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;

  const candidate = stored as Record<string, unknown>;
  const type = candidate['type'];

  switch (type) {
    case 'email':
    case 'username':
    case 'organisation':
    case 'telephone':
    case 'url':
      return { type };

    case 'name': {
      const part = candidate['part'];
      return { type, part: part === 'first' || part === 'last' ? part : 'full' };
    }

    case 'number': {
      const min = integer(candidate['min'], 0, GENERATOR_BOUNDS.number.min, GENERATOR_BOUNDS.number.max);
      const max = integer(candidate['max'], 100, GENERATOR_BOUNDS.number.min, GENERATOR_BOUNDS.number.max);
      return {
        type,
        min: Math.min(min, max),
        max: Math.max(min, max),
        decimals: integer(
          candidate['decimals'],
          0,
          GENERATOR_BOUNDS.decimals.min,
          GENERATOR_BOUNDS.decimals.max,
        ),
      };
    }

    case 'date': {
      const format = candidate['format'];
      return {
        type,
        format: typeof format === 'string' && format !== '' ? format : 'YYYY-MM-DD',
        from: typeof candidate['from'] === 'string' ? candidate['from'] : '1970-01-01',
        to: typeof candidate['to'] === 'string' ? candidate['to'] : '2035-12-31',
      };
    }

    case 'text': {
      const minWords = integer(candidate['minWords'], 5, GENERATOR_BOUNDS.words.min, GENERATOR_BOUNDS.words.max);
      const maxWords = integer(candidate['maxWords'], 20, GENERATOR_BOUNDS.words.min, GENERATOR_BOUNDS.words.max);
      return { type, minWords: Math.min(minWords, maxWords), maxWords: Math.max(minWords, maxWords) };
    }

    case 'alphanumeric': {
      const template = candidate['template'];
      return typeof template === 'string' && template !== '' ? { type, template } : undefined;
    }

    case 'regex': {
      const pattern = candidate['pattern'];
      return typeof pattern === 'string' && pattern !== '' ? { type, pattern } : undefined;
    }

    case 'list': {
      const items = strings(candidate['items'], []);
      return items.length > 0 ? { type, items } : undefined;
    }

    case 'constant': {
      const value = candidate['value'];
      return typeof value === 'string' ? { type, value } : undefined;
    }

    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ coercion */

/** One key's worth of coercion, so a single bad field cannot lose the rest. */
function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function strings(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : fallback;
}

/**
 * A list of glob patterns, with blank entries dropped.
 *
 * `parseMatcher` has always refused a blank field pattern. The two glob lists —
 * the excluded domains and a profile's addresses — went through `strings`
 * instead and kept theirs, so "Add a site" and then thinking better of it left a
 * blank entry in storage that survived every reload.
 *
 * UC-020 A1 did not say which of the two was right: it listed "the pattern is
 * empty" beside a malformed regex and said both were stored anyway, which was
 * never true of the empty one. It now separates them, because the argument it
 * gives — that refusing to store would discard a pattern half-way through being
 * typed — is about a pattern being written, and a blank one is not being
 * written. It is not there.
 *
 * That is not only untidy. `exclusionFor` treats an empty list as "the user
 * excluded nothing" and skips the check, which is what keeps a tab whose address
 * cannot be read fillable on a fresh install; one abandoned blank row makes the
 * list non-empty, and every unreadable tab is refused from then on. The user
 * sees a fill stop working and has an empty-looking row to explain it.
 *
 * Blank only. An *invalid* pattern is stored and flagged, exactly as an invalid
 * field pattern is (see `matcherProblems`): refusing to store it would discard a
 * half-typed pattern on every keystroke that made it briefly wrong. The rule is
 * that a blank is an absent entry, while a bad one is an entry with a problem.
 */
function globs(value: unknown, fallback: readonly string[]): readonly string[] {
  return strings(value, fallback).filter((pattern) => pattern !== '');
}
