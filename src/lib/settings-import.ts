import { DEFAULT_SETTINGS, parseSettings, type Settings } from './settings';

/**
 * Reading a configuration back in (UC-026, FR-053, FR-054, ND-13).
 *
 * Platform-free, and it writes nothing. What it produces is a *plan* — the state
 * that would be stored, both sides of the comparison the user is owed before
 * they agree to it, and every entry the file carried that the plan does not.
 * The options page shows the plan, the user confirms, and only then does
 * anything reach storage. That order is BR-026-3 and BR-026-5, and it is the
 * whole reason this module exists rather than the importer simply calling
 * `parseSettings` and saving the result.
 *
 * **The parser stays the only authority on what a valid state is.** Nothing here
 * re-implements a coercion rule, because a second implementation is how a user
 * comes to be told one thing by the preview and given another by the write — the
 * same drift BR-024-7 refuses between validating and loading. Instead this asks
 * `parseSettings` about one entry at a time and reports what came back. It is
 * strictly an *observer* of the parser: if the parser changes, the report
 * changes with it, and neither can be right while the other is wrong.
 */

/** The schema version this build writes and reads. */
export const SCHEMA_VERSION = DEFAULT_SETTINGS.version;

/**
 * Why an import was refused, as a catalog key and its substitutions.
 *
 * A code rather than a sentence, for the reason `RuleProblemCode` is one: the
 * wording belongs to the catalog (NFR-018) and this module has no host to
 * resolve it against. The `params` are values from the file — a version number,
 * a parser's own complaint — and are not translated.
 */
export type ImportRefusal = {
  readonly code:
    | 'importRefusedNotJson'
    | 'importRefusedNotObject'
    | 'importRefusedNewer'
    | 'importRefusedNothingOurs';
  readonly params: readonly string[];
};

/** One thing the file carried that the import will not keep (BR-026-3, A6, BR-026-7). */
export type ImportDrop = {
  readonly code:
    | 'importDroppedRule'
    | 'importDroppedProfile'
    | 'importDroppedProfileRule'
    | 'importDroppedKey';
  readonly params: readonly string[];
};

/**
 * What an import would do, computed before anything is written.
 *
 * `settings` is what would be stored — already coerced, so the user confirms the
 * state itself rather than a description of it.
 */
export type ImportPlan = {
  readonly settings: Settings;
  /** Rules and profiles the plan would store, against what is there now (BR-026-5). */
  readonly incoming: Counts;
  readonly current: Counts;
  readonly dropped: readonly ImportDrop[];
  /**
   * Whether the file came from an older schema, or stated no version at all
   * (A3, A4). Reported because the user is entitled to know their file was
   * changed on the way in, and because what stands in for the ladder today is a
   * tolerant parser whose losses are only visible in `dropped`.
   */
  readonly migrated: boolean;
};

export type Counts = { readonly rules: number; readonly profiles: number };

export type ImportOutcome =
  | { readonly ok: true; readonly plan: ImportPlan }
  | { readonly ok: false; readonly refusal: ImportRefusal };

/**
 * The root keys this build knows, including the pre-DD-005 flat ones.
 *
 * The legacy four are here because A4 is a supported path: `parseSettings` still
 * reads `dispatchEvents`, `skipHidden`, `skipPreFilled` and `ignorePatterns`
 * from the top level, so a file carrying them is being *understood*, not
 * tolerated, and reporting them as unrecognised would be wrong twice over — it
 * would name a key that was in fact kept, and it would push a file the importer
 * handles towards A5's refusal.
 */
const ROOT_KEYS: ReadonlySet<string> = new Set([
  'version',
  'locale',
  'rules',
  'profiles',
  'exclusions',
  'behaviour',
  'passwords',
  'sources',
  'triggers',
  'dispatchEvents',
  'skipHidden',
  'skipPreFilled',
  'ignorePatterns',
]);

/**
 * The root keys that carry configuration, as opposed to describing it.
 *
 * Derived from the set above rather than restated, because the two must not be
 * able to disagree: a key added to `ROOT_KEYS` and forgotten here would make
 * every file whose only section is that key read as "nothing of ours", and the
 * import would be refused for a reason that is not true.
 *
 * `version` is the one exclusion, and A5 turns on it. A file holding nothing
 * but a version number carries no setting this extension could apply, so
 * treating it as ours would import a complete set of defaults over the user's
 * configuration and report success — precisely the outcome BR-026-4 exists to
 * prevent, reached by a file that happens to share one key name with us.
 */
const SECTION_KEYS: readonly string[] = [...ROOT_KEYS].filter((key) => key !== 'version');

/**
 * The keys each known shape may carry, for BR-026-7.
 *
 * Named constants rather than one lookup table, so that reaching for the wrong
 * shape is a compile error and no caller has to prove to the type checker that
 * the shape it asked for exists. The table version needed an
 * `if (known !== undefined)` at all five call sites, guarding a case that could
 * not happen.
 */
const RULE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'enabled',
  'match',
  'sources',
  'generator',
  'fromPersona',
]);
const PROFILE_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'enabled', 'urls', 'rules']);
const SECTION_SHAPES: readonly (readonly [string, ReadonlySet<string>])[] = [
  ['exclusions', new Set(['fields', 'domains'])],
  [
    'behaviour',
    new Set([
      'dispatchEvents',
      'skipHidden',
      'skipPreFilled',
      'maxLengths',
      'consentKeywords',
      'confirmationKeywords',
    ]),
  ],
  ['passwords', new Set(['length', 'upper', 'lower', 'digits', 'symbols'])],
  ['sources', new Set(['name', 'id', 'className', 'label', 'placeholder', 'ariaLabel'])],
  ['triggers', new Set(['contextMenu'])],
];

/**
 * Reads a file and works out what importing it would do.
 *
 * The order of the checks is the order of the use case's steps, and it is load
 * bearing: a file from a newer schema is refused on its version (A2, step 3)
 * before anything asks whether its contents are recognisable (A5, step 4). A
 * newer file whose sections this build cannot name would otherwise be refused
 * for the wrong reason, and the user would be told their file is not ours when
 * what it actually needs is a newer extension.
 */
export function analyseImport(text: string, current: Settings): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A1, with the parser's own complaint. It names the offset, which is the
    // only useful thing anyone can say about a file that is not JSON.
    return refuse('importRefusedNotJson', [error instanceof Error ? error.message : String(error)]);
  }

  // A1's second half. An array, a number and a bare string are all valid JSON
  // and none of them is a configuration; they are separated from the syntax
  // failure because the correction is different.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('importRefusedNotObject', []);
  }

  const file = parsed as Record<string, unknown>;
  const stated = typeof file['version'] === 'number' ? file['version'] : undefined;

  // A2. Refused, never coerced, and ND-13 forbids an override. Coercing forward
  // discards what this build cannot name, from a file that may be the only copy
  // — and neither we nor the user could see what went.
  if (stated !== undefined && stated > SCHEMA_VERSION) {
    return refuse('importRefusedNewer', [String(stated), String(SCHEMA_VERSION)]);
  }

  // A5 / BR-026-4. The check that has to exist because the tolerant parser
  // cannot fail: handed an object it does not recognise, it returns a complete
  // and entirely default configuration, so the import would report success and
  // the user would have lost everything they had.
  if (!SECTION_KEYS.some((key) => key in file)) {
    return refuse('importRefusedNothingOurs', []);
  }

  const settings = parseSettings(file);
  return {
    ok: true,
    plan: {
      settings,
      incoming: { rules: settings.rules.length, profiles: settings.profiles.length },
      current: { rules: current.rules.length, profiles: current.profiles.length },
      dropped: [...droppedEntries(file), ...unknownKeys(file)],
      // A3 and A4 are the same fact to the user — the file did not come from
      // this schema and was changed on the way in — and today they are also the
      // same mechanism, since the tolerant parser stands in for the ladder.
      migrated: stated !== SCHEMA_VERSION,
    },
  };
}

function refuse(code: ImportRefusal['code'], params: readonly string[]): ImportOutcome {
  return { ok: false, refusal: { code, params } };
}

/**
 * Every rule and profile in the file that the parser will not keep.
 *
 * Each entry is put to `parseSettings` **on its own**, inside an otherwise empty
 * state, and kept or dropped according to what comes back. Asking the real
 * parser one entry at a time is what makes this a report rather than a second
 * opinion: there is no rule here about what makes a rule readable, so there is
 * nothing to fall out of step with `parseRule`.
 *
 * Identity is deliberately not used to match survivors against the file's
 * entries. `parseRule` falls back to the match pattern when a rule states no
 * `id`, so two rules in one file can arrive carrying the same one, and a diff
 * keyed on it would report a survivor as dropped.
 */
function droppedEntries(file: Record<string, unknown>): readonly ImportDrop[] {
  const drops: ImportDrop[] = [];

  for (const [index, entry] of listAt(file, 'rules').entries()) {
    if (!keepsRule(entry)) drops.push({ code: 'importDroppedRule', params: [nameOf(entry, index)] });
  }

  for (const [index, entry] of listAt(file, 'profiles').entries()) {
    if (parseSettings({ profiles: [entry] }).profiles.length !== 1) {
      drops.push({ code: 'importDroppedProfile', params: [nameOf(entry, index)] });
      continue;
    }

    // The profile survives; its own rules are parsed by the same function and
    // can be dropped individually, which the profile's count alone would hide.
    for (const [at, rule] of listAt(record(entry), 'rules').entries()) {
      if (keepsRule(rule)) continue;
      drops.push({
        code: 'importDroppedProfileRule',
        params: [nameOf(entry, index), nameOf(rule, at)],
      });
    }
  }

  return drops;
}

function keepsRule(entry: unknown): boolean {
  return parseSettings({ rules: [entry] }).rules.length === 1;
}

/**
 * BR-026-7: keys this build does not know, named rather than silently ignored.
 *
 * Reported by path — `behaviour.wobble`, `rules[2].colour` — so that "I added
 * that by hand and it did nothing" has an answer. It descends only into shapes
 * the schema defines; an unknown key's own contents are not explored, because
 * nothing below an unrecognised name has a meaning to report against.
 */
function unknownKeys(file: Record<string, unknown>): readonly ImportDrop[] {
  const drops: ImportDrop[] = [];

  const scan = (value: unknown, known: ReadonlySet<string>, path: string): void => {
    for (const key of Object.keys(record(value))) {
      if (!known.has(key)) drops.push({ code: 'importDroppedKey', params: [`${path}${key}`] });
    }
  };

  scan(file, ROOT_KEYS, '');
  for (const [section, known] of SECTION_SHAPES) scan(file[section], known, `${section}.`);

  for (const [index, rule] of listAt(file, 'rules').entries()) {
    scan(rule, RULE_KEYS, `rules[${index}].`);
  }

  for (const [index, profile] of listAt(file, 'profiles').entries()) {
    scan(profile, PROFILE_KEYS, `profiles[${index}].`);
    for (const [at, rule] of listAt(record(profile), 'rules').entries()) {
      scan(rule, RULE_KEYS, `profiles[${index}].rules[${at}].`);
    }
  }

  return drops;
}

/**
 * What to call an entry in the report, using whatever the file gave it.
 *
 * A dropped rule is dropped precisely because something about it could not be
 * read, so its name has to come from wherever a name survives — the label, then
 * the pattern, then its position. The position is the last resort rather than
 * the first because "rule 4" is only findable by counting, and the file may be
 * open in front of the user.
 */
function nameOf(entry: unknown, index: number): string {
  const candidate = record(entry);
  const label = candidate['label'];
  if (typeof label === 'string' && label.trim() !== '') return label;

  const pattern = record(candidate['match'])['pattern'];
  if (typeof pattern === 'string' && pattern.trim() !== '') return pattern;

  return `#${index + 1}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A list-valued key, or an empty list — a file may put anything under any name. */
function listAt(value: Record<string, unknown>, key: string): readonly unknown[] {
  const list = value[key];
  return Array.isArray(list) ? list : [];
}
