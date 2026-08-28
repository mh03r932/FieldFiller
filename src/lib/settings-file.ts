import {
  MATCH_SOURCES,
  type Generator,
  type Matcher,
  type Profile,
  type Rule,
  type Settings,
} from './settings';
import type { ControlKind } from './protocol';

/**
 * The file a configuration leaves in (UC-025, FR-052, ND-12).
 *
 * Platform-free, like `settings.ts` next door: this module knows what the file
 * *is*, not how it reaches the disk. The anchor and the object URL are the
 * options page's job (`export-section.ts`), which is what keeps this testable
 * without a browser host and what will let UC-026 read the same shape back
 * without importing anything from a page.
 *
 * **The file is the settings state itself, with no envelope around it.** No
 * exporting-tool name, no timestamp, no device. `version` is already a field of
 * the schema (BR-025-6), so an envelope would add a second place for the version
 * to live and a second thing UC-026 has to disbelieve. It also keeps A5 of
 * UC-026 meaningful: a file with no key the schema recognises is refused, and
 * that check is only possible while the top level of the file *is* the schema.
 *
 * Everything below exists to make one property true: **the same configuration
 * serialises to the same bytes, every time, on every machine** (BR-025-3). That
 * is what makes the file diffable, and a file that cannot be diffed is not the
 * thing ND-12 chose plain JSON for.
 */

/**
 * The name the file is offered under (UC-025 step 4).
 *
 * The extension and the schema version, and deliberately nothing else. A date or
 * a counter here would be a clock in the export path, which BR-025-3 forbids for
 * the file's contents and which would be no less confusing in its name: two
 * exports of an unchanged configuration would land as two files that a diff
 * would have to be pointed at by hand.
 *
 * Re-exporting therefore offers the same name, and the browser's own
 * de-duplication (`…(1).json`) is what distinguishes them — a decision belonging
 * to the download, where the user can see it, rather than to us.
 */
export function settingsFileName(settings: Settings): string {
  return `fieldfiller-settings-v${settings.version}.json`;
}

/** The media type the file is offered as. Plain JSON is the whole of ND-12. */
export const SETTINGS_FILE_TYPE = 'application/json';

/**
 * A whole configuration as the text of a file (BR-025-1, BR-025-3, BR-025-4).
 *
 * Two-space indentation, one key per line, and a trailing newline so the file is
 * a well-formed text file rather than one a diff reports as lacking its last
 * line forever.
 *
 * Non-ASCII text is emitted as itself. That is `JSON.stringify`'s own behaviour
 * rather than something arranged here, but BR-025-4 states it as a promise — a
 * de-CH user's rule named `Kundenstraße` reads as `Kundenstraße` in the diff —
 * so `tests/settings-file.test.ts` asserts it instead of trusting that the
 * default never changes.
 */
export function serialiseSettings(settings: Settings): string {
  return `${JSON.stringify(canonicalSettings(settings), undefined, 2)}\n`;
}

/**
 * The state, rebuilt key by key in the schema's order.
 *
 * **Exported since 2026-08-28, because the file is no longer the only place a
 * configuration is written key by key.** UC-029's synchronised replica needs the
 * same canonical form for two reasons the export already had — a stable byte
 * count to measure against a quota, and a normal form to compare a returning
 * write against — plus one of its own: the replica is compared against local
 * settings on every arrival, and two states that differ only in key order would
 * read as a foreign write on every sync event, in a loop. One definition, so the
 * file and the replica cannot disagree about what a rule looks like.
 *
 * Not `JSON.stringify(settings)` directly, and the reason is BR-025-3 rather
 * than tidiness. A JavaScript object's keys come out in insertion order, and the
 * settings state reaching this point has been through storage — which is not a
 * neutral pipe. **`chrome.storage.local` hands the state back with its keys in
 * alphabetical order**, at every level, measured in `scripts/e2e-export.mjs`
 * rather than assumed: a state written `version, locale, rules, …` reads back
 * `behaviour, exclusions, locale, …`. Stringifying what storage returned would
 * therefore emit a file in an order this schema never chose, and would emit a
 * different one the day a storage backend sorts differently — so every export
 * would be a diff that means nothing, which is the one thing ND-12 picked plain
 * JSON to avoid. Restating the order here makes it a property of this module,
 * where it can be read and tested, rather than an accident of the round trip.
 *
 * Every section is present whether or not it differs from the shipped defaults
 * (BR-025-1). A file that omitted what happens to match the defaults would mean
 * something different the moment a default changed, and UC-026 could not tell
 * "the user chose this" from "the user's version did not have this key yet".
 */
export function canonicalSettings(settings: Settings): Record<string, unknown> {
  return {
    version: settings.version,
    locale: settings.locale,
    rules: settings.rules.map(ruleShape),
    profiles: settings.profiles.map(profileShape),
    exclusions: {
      fields: settings.exclusions.fields.map(matcherShape),
      // A copy, because the file must not be able to alias the live state — and
      // spread rather than the array itself so the JSON has no reference back
      // into settings memory at all.
      domains: [...settings.exclusions.domains],
    },
    behaviour: {
      dispatchEvents: settings.behaviour.dispatchEvents,
      skipHidden: settings.behaviour.skipHidden,
      skipPreFilled: settings.behaviour.skipPreFilled,
      maxLengths: maxLengthsShape(settings.behaviour.maxLengths),
      consentKeywords: [...settings.behaviour.consentKeywords],
      confirmationKeywords: [...settings.behaviour.confirmationKeywords],
    },
    passwords: {
      // The policy, and only ever the policy (BR-025-5). Length and character
      // classes are what a password rule is; the password itself is generated
      // per fill and never stored anywhere (NFR-010, NFR-031), so there is
      // nothing here to leave out — the file cannot carry one because the
      // extension never has one to carry.
      length: settings.passwords.length,
      upper: settings.passwords.upper,
      lower: settings.passwords.lower,
      digits: settings.passwords.digits,
      symbols: settings.passwords.symbols,
    },
    // In `MATCH_SOURCES` order rather than the object's own, for the reason the
    // sections are: this record's key order came from wherever it was built.
    sources: Object.fromEntries(MATCH_SOURCES.map((source) => [source, settings.sources[source]])),
    triggers: {
      contextMenu: settings.triggers.contextMenu,
    },
  };
}

function ruleShape(rule: Rule): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    id: rule.id,
    label: rule.label,
    enabled: rule.enabled,
    match: matcherShape(rule.match),
  };

  // Absent means "whatever is enabled globally" (FR-067), so an absent key is
  // written as an absent key. Emitting the resolved list instead would freeze
  // today's global toggles into every rule, and a file that turned an inheriting
  // rule into a pinned one would change what the configuration *does* on the
  // machine it was imported onto — silently, and only for someone whose toggles
  // differ from the exporter's.
  if (rule.sources !== undefined) shape['sources'] = [...rule.sources];

  shape['generator'] = generatorShape(rule.generator);
  shape['fromPersona'] = rule.fromPersona;
  return shape;
}

function profileShape(profile: Profile): Record<string, unknown> {
  return {
    id: profile.id,
    label: profile.label,
    enabled: profile.enabled,
    urls: [...profile.urls],
    rules: profile.rules.map(ruleShape),
  };
}

function matcherShape(matcher: Matcher): Record<string, unknown> {
  return { mode: matcher.mode, pattern: matcher.pattern };
}

/**
 * One generator, discriminant first and then its own fields.
 *
 * A `switch` with no `default`, so adding a generator type to the union is a
 * compile error here rather than a rule that exports as `{"type":"…"}` with its
 * configuration missing — which the tolerant parser would then read back as a
 * different generator entirely, without an error at either end.
 */
function generatorShape(generator: Generator): Record<string, unknown> {
  switch (generator.type) {
    case 'name':
      return { type: generator.type, part: generator.part };
    case 'email':
    case 'username':
    case 'organisation':
    case 'telephone':
    case 'url':
      return { type: generator.type };
    case 'number':
      return {
        type: generator.type,
        min: generator.min,
        max: generator.max,
        decimals: generator.decimals,
      };
    case 'date':
      return { type: generator.type, format: generator.format, from: generator.from, to: generator.to };
    case 'text':
      return { type: generator.type, minWords: generator.minWords, maxWords: generator.maxWords };
    case 'alphanumeric':
      return { type: generator.type, template: generator.template };
    case 'regex':
      return { type: generator.type, pattern: generator.pattern };
    case 'list':
      return { type: generator.type, items: [...generator.items] };
    case 'constant':
      return { type: generator.type, value: generator.value };
  }
}

/**
 * The per-kind length caps, in a canonical order.
 *
 * The one record here whose keys are *data* rather than schema: a user caps
 * whichever control kinds they care about, so there is no declared order to
 * restate. Sorted, therefore — which is arbitrary but stable, and stable is the
 * whole requirement. Ordering by the `ControlKind` union instead would be no
 * more meaningful and would put this file's output at the mercy of an unrelated
 * edit to that union's order.
 */
function maxLengthsShape(caps: Partial<Record<ControlKind, number>>): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const kind of Object.keys(caps).sort()) {
    const cap = caps[kind as ControlKind];
    if (cap !== undefined) shape[kind] = cap;
  }
  return shape;
}
