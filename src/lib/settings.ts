import {type Locale, LOCALES} from './persona/corpus/corpus';
import type {AgentSettings, ControlKind} from './protocol';

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
export type MatchMode = 'contains' | 'exact' | 'regex';

/**
 * The identity sources a pattern may be compared against (FR-027, FR-028).
 *
 * Exactly the six the page agent puts on a descriptor. `autocomplete` is not
 * here: it is a controlled vocabulary rather than free text, and matching a
 * regex against it would invite rules that duplicate what the generator already
 * reads from it directly.
 */
export type MatchSource = 'name' | 'id' | 'className' | 'label' | 'placeholder' | 'ariaLabel';

export const MATCH_SOURCES: readonly MatchSource[] = [
  'name',
  'id',
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

export type NamePart = 'full' | 'first' | 'last';

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

export type Exclusions = {
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
export type Triggers = {
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

export const DEFAULT_SOURCES: SourceToggles = {
  name: true,
  id: true,
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

export const DEFAULT_TRIGGERS: Triggers = {
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
    ignorePatterns: settings.exclusions.fields.map(patternSource),
  };
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
  const behaviour = record(candidate['behaviour']);
  const exclusions = record(candidate['exclusions']);
  const passwords = record(candidate['passwords']);
  const sources = record(candidate['sources']);

  return {
    version: 1,
    locale: parseLocale(candidate['locale']),
    rules: parseRules(candidate['rules']),
    profiles: parseProfiles(candidate['profiles']),
    exclusions: {
      fields: parseMatchers(exclusions['fields'] ?? candidate['ignorePatterns']),
      domains: strings(exclusions['domains'], DEFAULT_SETTINGS.exclusions.domains),
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
      contextMenu: boolean(record(candidate['triggers'])['contextMenu'], DEFAULT_TRIGGERS.contextMenu),
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
  for (const entry of stored) {
    const rule = parseRule(entry);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
}

function parseRule(stored: unknown): Rule | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;

  const candidate = stored as Record<string, unknown>;
  const match = parseMatcher(candidate['match']);
  const generator = parseGenerator(candidate['generator']);
  if (match === undefined || generator === undefined) return undefined;

  const sources = parseSourceList(candidate['sources']);
  return {
    id: typeof candidate['id'] === 'string' ? candidate['id'] : match.pattern,
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
      urls: strings(candidate['urls'], []),
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
      const min = integer(candidate['min'], 0, -1e15, 1e15);
      const max = integer(candidate['max'], 100, -1e15, 1e15);
      return {
        type,
        min: Math.min(min, max),
        max: Math.max(min, max),
        decimals: integer(candidate['decimals'], 0, 0, 10),
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
      const minWords = integer(candidate['minWords'], 5, 1, 500);
      const maxWords = integer(candidate['maxWords'], 20, 1, 500);
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
