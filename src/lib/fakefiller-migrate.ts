import {
  DEFAULT_SETTINGS,
  GENERATOR_BOUNDS,
  PERSONA_BACKED,
  type Generator,
  type Profile,
  type Rule,
  type Settings,
  type SourceToggles,
} from './settings';
import { validateMatcher, validateRule, type RuleProblem } from './rules/validate';
import { MAX_IMPORT_SIZE, oversizeRefusal, kindOf, type Counts } from './settings-import';
import { decodeBackupTransport, looksLikeFakeFiller } from './fakefiller-recognise';

/**
 * UC-027 — a Fake Filler backup, translated into this extension's schema
 * (FR-055, FR-056, ND-13, PD-002).
 *
 * The same shape as `settings-import` beside it, because the two make the
 * same promise and differ only in where the file came from: nothing here
 * writes anything, `analyseMigration` produces a *plan* — the state that
 * would be stored, both sides of the comparison, and two lists of losses —
 * and the options page shows the plan and asks. That order is the use
 * case's whole design, stated once in UC-026 and inherited here.
 *
 * **A migration replaces; it never merges (BR-027-1).** The `settings`
 * below is complete: every section is either translated from the backup or
 * is this extension's default, and nothing from the running configuration
 * survives into it except through `current`, which is only ever *read*, for
 * the "what is stored now" half of the summary.
 *
 * **The translation is written against the published schema** — the
 * `IFakeFillerOptions`/`ICustomField`/`IProfile` shapes recorded in
 * `FAKEFILLER_RESEARCH.md` §2.2 from commit `36daf90` (BR-027-2). The
 * published extension is known to run ahead of that source (§4 of the
 * research), which is why the report leads with the version the file
 * claims when it is not the documented one (A2) rather than refusing: the
 * reference's own export still opens in the reference, so the migrant has
 * lost nothing by trying, and a field whose *meaning* changed between the
 * documented schema and the store build cannot be detected from here at
 * all.
 *
 * **Two deviations from the spec's translation table, both toward its own
 * BR-027-5 and both recorded here rather than buried in a branch.** The
 * table says moment tokens with no counterpart "pass through as literals
 * and are named". Taken literally that is unimplementable for most of
 * them: a literal `PM` or `SSS` would be text every generated date carries
 * forever, and `MMMM` would *half*-substitute, because our own `MMM` token
 * matches inside it. A literal that secretly substitutes is exactly the
 * "plausible conversion that is sometimes wrong" BR-027-5 exists to
 * forbid, in this case escaping through the spec's own letter. So an
 * untranslatable date token becomes the nearest token or nothing — always
 * named — which is what the alphanumeric row of the same table does by
 * design, and the date row is read in that light. The second deviation is
 * smaller: a profile whose `urlMatch` is an empty string arrives disabled
 * like every other (A5), rather than as the glob `*` an empty regex
 * technically equals. `*` would be exact, but A5 draws no such case and
 * adding one is a specialism the report would have to explain; uniform is
 * honest, and setting patterns is one visit to the editor.
 */

/* ------------------------------------------------------------------ refusal */

/**
 * Why a migration was refused, as a catalog key and its substitutions —
 * the importer's discipline, for its reason: this module has no host to
 * resolve a sentence against (NFR-018).
 */
export type MigrationRefusal = {
  readonly code:
    | 'migrateRefusedTooLarge'
    | 'migrateRefusedNotJson'
    | 'migrateRefusedNotObject'
    | 'migrateRefusedNotBackup'
    | 'migrateRefusedOurs';
  readonly params: readonly string[];
};

/* -------------------------------------------------------------------- losses */

/**
 * One thing the backup carried that the translation will not (BR-027-3,
 * A4, A6).
 *
 * The same shape as the importer's `ImportDrop` with its own codes,
 * because the sentences differ: an import loses entries *this* schema
 * wrote, a migration loses things a different extension's users configured
 * in a different vocabulary, and a line that read "could not be read"
 * about a Fake Filler field that was read perfectly well and refused would
 * send the user to fix a file that has nothing wrong with it.
 */
export type MigrationDrop = {
  readonly code:
    | 'migrateDroppedField'
    | 'migrateDroppedFieldNoMatch'
    | 'migrateDroppedFieldUnknownType'
    | 'migrateDroppedFieldRefused'
    | 'migrateDroppedProfile'
    | 'migrateDroppedProfileField'
    | 'migrateDroppedProfileFieldNoMatch'
    | 'migrateDroppedProfileFieldUnknownType'
    | 'migrateDroppedProfileFieldRefused'
    | 'migrateDroppedPasswordDefined'
    | 'migrateDroppedShape'
    | 'migrateDroppedKey';
  readonly params: readonly string[];
  /**
   * The fault behind a refused rule (A4), carried rather than worded — a
   * `RuleProblem` is already a catalog key, and the surface resolves it.
   *
   * `validateRule`'s own wording is used unchanged, per A4 step 1: "worded
   * as the editor words it". One function decides what the editor writes
   * and what a migration stores, which is the same property the importer's
   * `storable` exists for.
   */
  readonly problem?: RuleProblem;
};

/**
 * One thing the translation *will* store that differs from what the backup
 * held (A3, A5, BR-027-3).
 *
 * Separate from `dropped` for the reason the importer's notes are: a drop
 * is an entry that will not be there afterwards, a note is an entry that
 * will, and the two promises cannot be folded into one list without making
 * every line of it mean "either gone or not, see the sentence".
 */
export type MigrationNote = {
  readonly code:
    | 'migrateNotedExclusion'
    | 'migrateNotedField'
    | 'migrateNotedProfileField'
    | 'migrateNotedProfileUrl'
    | 'migrateNotedSourcesSplit'
    | 'migrateNotedDefaultMaxLength'
    | 'migrateNotedPasswordRandom';
  readonly params: readonly string[];
  /**
   * The fault behind an exclusion note, carried rather than worded — the
   * importer's `ImportNote` discipline, for its reason: a `RuleProblem` is
   * already a catalog key, and the surface resolves it into the sentence.
   */
  readonly problem?: RuleProblem;
};

/* --------------------------------------------------------------------- plan */

/**
 * What a migration would do, computed before anything is written.
 *
 * `settings` is what would be stored — the translation, complete, already
 * reduced to rules `validateRule` accepts — so the user confirms the state
 * itself rather than a description of it.
 */
export type MigrationPlan = {
  readonly settings: Settings;
  readonly incoming: Counts;
  readonly current: Counts;
  readonly dropped: readonly MigrationDrop[];
  readonly noted: readonly MigrationNote[];
  /**
   * The schema version the backup claims, or `undefined` when it states
   * none (A2). Reported whenever it is not the documented `1`: which
   * version the file claims, which the translation was written against,
   * and that a changed *meaning* is undetectable from here.
   */
  readonly sourceVersion: number | undefined;
  readonly versionStated: boolean;
  /**
   * Whether any translated rule is persona-backed (BR-027-6) — global rules
   * *and* profile rules, since both draw from the fill's person identically.
   * Said once, at the top of the report — the email a migrated rule writes
   * still matching the name another field shows is a deliberate behaviour
   * change from the reference, in the direction this product defines as
   * correct, and it is cheaper to state once than to name on every rule.
   */
  readonly personaBacked: boolean;
};

export type MigrationOutcome =
  | { readonly ok: true; readonly plan: MigrationPlan }
  | { readonly ok: false; readonly refusal: MigrationRefusal };

/* ------------------------------------------------------------------ analysis */

/**
 * Reads a backup and works out what migrating it would do.
 *
 * The order of the checks is the use case's steps and it is load-bearing:
 * the size bound comes first because everything after it is unbounded work
 * on a file nobody here wrote (A8, in UC-026 A9's words); the transport
 * decode comes before recognition because the reference's export *is*
 * Base64 and recognition cannot run on the encoded text (step 2); and
 * recognition comes before translation because everything after it is
 * decided by what the file already proved it is (step 3).
 */
export function analyseMigration(text: string, current: Settings): MigrationOutcome {
  if (text.length > MAX_IMPORT_SIZE) {
    // A8, and the bound is UC-026 A9's, not a new one: a real backup is
    // kilobytes — the reference caps its free tier at twenty-five fields —
    // and the cost being bounded is the same read and analysis on the same
    // thread. The refusal's substitutions come from the importer's own
    // function, so the two surfaces say the same thing about the same
    // number; only the sentence frame is migration's, because what the
    // user was trying to do differs.
    const shared = oversizeRefusal(text.length);
    return { ok: false, refusal: { code: 'migrateRefusedTooLarge', params: shared.params } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Step 2: the reference's transport is Base64, so a file that is not
    // JSON may still be a backup — the reference exports download as
    // `fake-filler-YYYY-MM-DD.txt` containing exactly that. Decode, then
    // parse what comes out. A1's refusal has to say which of the two
    // failed, because the correction is different: re-export from the
    // reference, or stop pointing this at a Fake Filler backup at all.
    const decoded = decodeBackupTransport(text.trim());
    if (decoded === undefined) {
      return refuse('migrateRefusedNotJson', [reasonOf(error)]);
    }
    try {
      parsed = JSON.parse(decoded);
    } catch (decodedError) {
      return refuse('migrateRefusedNotJson', [reasonOf(decodedError)]);
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('migrateRefusedNotObject', []);
  }

  const file = parsed as Record<string, unknown>;

  if (!looksLikeFakeFiller(file)) {
    // A1's mirror of UC-026 A5, and the reason recognition runs on the
    // reference's key set rather than on failure to parse ours: a file
    // that looks like *our* export has a better answer than "not a
    // backup", and it points at the import section above.
    if (looksLikeOurs(file)) return refuse('migrateRefusedOurs', []);
    return refuse('migrateRefusedNotBackup', []);
  }

  return { ok: true, plan: translate(file, current) };
}

function refuse(code: MigrationRefusal['code'], params: readonly string[]): MigrationOutcome {
  return { ok: false, refusal: { code, params } };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a file looks like *our* export (A1 step 2).
 *
 * Read off `DEFAULT_SETTINGS`' own keys rather than a list restated here,
 * so the two cannot drift: a key added to the schema and forgotten in a
 * local copy would make every future export answer "not ours" to the one
 * question whose wrong answer sends the user to the wrong feature.
 *
 * `version` and `profiles` excluded, because the reference's documented
 * schema carries both too — and this check runs only after Fake Filler
 * recognition has already said no, so what remains of the shared ground
 * is exactly the ground a file of `{version, profiles}` sits on: neither
 * a backup (no `fields`) nor an export of ours (no section a real export
 * omits). Such a file meets the plain not-a-backup refusal below, which
 * is the honest answer for something neither product clearly wrote.
 */
function looksLikeOurs(file: Record<string, unknown>): boolean {
  const ours = Object.keys(DEFAULT_SETTINGS).filter(
    (key) => key !== 'version' && key !== 'profiles',
  );
  return ours.some((key) => key in file);
}

/* ---------------------------------------------------------------- transition */

/**
 * The whole mapping table (step 4), section by section.
 *
 * Each root setting is translated independently, because the reference
 * has no section the loss of which loses another: a backup of only
 * `fields` is a backup, and so is one of only `ignoredFields`.
 */
function translate(file: Record<string, unknown>, current: Settings): MigrationPlan {
  const dropped: MigrationDrop[] = [];
  const noted: MigrationNote[] = [];

  // Entries the loops below drop, by index, so `unknownEntryKeys` does not
  // pick through a corpse: an entry reported as a loss has nothing stored
  // to describe, and a second line about its keys would inflate the count
  // the user is deciding on (the importer's `reported` set, same reason).
  const droppedFields = new Set<number>();
  const droppedProfiles = new Set<number>();
  /**
   * Fields dropped *inside* a profile, by profile index then position, for
   * the same reason `droppedFields` exists: `unknownEntryKeys` must not pick
   * through a corpse, and a profile's dropped field is as much a corpse as
   * a dropped global one. The map's key is the index in the *file's* list,
   * which is what the scan walks — surviving profiles keep their indexes
   * because garbage entries are skipped without renumbering.
   */
  const droppedProfileFields = new Map<number, Set<number>>();

  const rules: Rule[] = [];
  for (const [index, entry] of listAt(file, 'fields').entries()) {
    const outcome = translateField(entry, index, `ff-rule-${String(index)}`);
    if (outcome.kind === 'drop') {
      dropped.push(...asGlobalDrops(outcome.drop));
      droppedFields.add(index);
    } else {
      rules.push(outcome.rule);
      if (outcome.losses.length > 0) {
        noted.push({ code: 'migrateNotedField', params: [outcome.name, outcome.losses.join('; ')] });
      }
    }
  }

  const profiles: Profile[] = [];
  for (const [index, entry] of listAt(file, 'profiles').entries()) {
    // An entry that is not an object is not a profile — dropped whole and
    // named, for the reason an unreadable `fields[]` entry is: there is
    // nothing to translate and no name to translate it under, and the
    // `asRecord` tolerance below used to turn it into an empty disabled
    // profile with a urlMatch note, which is a thing the backup never
    // carried wearing a successful translation's face.
    if (kindOf(entry) !== 'object') {
      dropped.push({ code: 'migrateDroppedProfile', params: [`#${String(index + 1)}`] });
      droppedProfiles.add(index);
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = stringOf(record['name'], `#${String(index + 1)}`);
    const profileRules: Rule[] = [];

    for (const [at, field] of listAt(record, 'fields').entries()) {
      const outcome = translateField(field, at, `ff-profile-${String(index)}-rule-${String(at)}`);
      if (outcome.kind === 'drop') {
        dropped.push(...asProfileDrops(outcome.drop, name));
        const corpse = droppedProfileFields.get(index) ?? new Set<number>();
        corpse.add(at);
        droppedProfileFields.set(index, corpse);
      } else {
        profileRules.push(outcome.rule);
        if (outcome.losses.length > 0) {
          noted.push({
            code: 'migrateNotedProfileField',
            params: [name, outcome.name, outcome.losses.join('; ')],
          });
        }
      }
    }

    // A5: the URL match is a regular expression and ours are globs, and a
    // conversion that is *sometimes* right is a profile that silently
    // fires on the wrong pages — a behaviour change on the importing
    // machine wearing a successful migration's face (BR-027-5). Disabled
    // with no patterns is the honest middle: nothing silently lost, the
    // rules translated like any others, one visit to the profile editor
    // from the report's own words away.
    //
    // Every profile, including one whose `urlMatch` is empty: the empty
    // regex matches every page, and `*` would be exact — but A5 draws no
    // such case, and a specialism the report has to explain is a worse
    // trade than a line the user already knows how to act on.
    const urlMatch = stringOf(record['urlMatch'], '');
    noted.push({ code: 'migrateNotedProfileUrl', params: [name, urlMatch] });
    profiles.push({
      id: `ff-profile-${String(index)}`,
      label: name,
      enabled: false,
      urls: [],
      rules: profileRules,
    });
  }

  const behaviour = translateBehaviour(file, dropped, noted);
  const passwords = translatePasswords(file, dropped, noted);
  const sources = translateSources(asRecord(file['fieldMatchSettings']), noted);

  // The reference's ignored-field patterns, carried as `regex`-mode
  // exclusions and *named* when they carry a fault — the importer's
  // `notedExclusions`, for its reason and almost in its words: one
  // `validateMatcher`, one file, one answer, or a pattern this build flags
  // in the exclusion editor arrives from a migration with the report saying
  // nothing. The reference never screened a pattern in its life (A4's own
  // argument), so a backup is exactly as likely to carry `(a+)+b` here as
  // in a field's match list — kept, not refused, on the editor's terms
  // (UC-005 A5: the list stores patterns that are invalid on purpose), and
  // noted so PD-002's account includes it. What a fill does with it is
  // already contained: `fillableExclusions` does not send a refused pattern
  // to a page and the fill report names it there (NFR-009).
  //
  // The total-loss case is the keyword lists' (`keywordsOf`'s boundary):
  // a non-empty list from which no pattern can be read names its key rather
  // than silently arriving as "the user excluded nothing" — which is what
  // the filter would otherwise manufacture out of `[42]`.
  const rawIgnored = listAt(file, 'ignoredFields');
  const ignoredFields = rawIgnored
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    .map((pattern) => ({ mode: 'regex' as const, pattern }));
  if (rawIgnored.length > 0 && ignoredFields.length === 0) {
    dropped.push({ code: 'migrateDroppedShape', params: ['ignoredFields'] });
  }
  for (const matcher of ignoredFields) {
    const problem = validateMatcher(matcher)[0];
    if (problem !== undefined) {
      noted.push({ code: 'migrateNotedExclusion', params: [matcher.pattern], problem });
    }
  }

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    rules,
    profiles,
    exclusions: {
      fields: ignoredFields,
      domains: [],
    },
    behaviour,
    passwords,
    sources,
    triggers: {
      contextMenu: booleanOf(file['enableContextMenu'], DEFAULT_SETTINGS.triggers.contextMenu),
    },
  };

  // The report's order: the user's own fields first (already pushed by the
  // loops above), then keys the entries carried that no entry has a place
  // for, then the file's own structure. The importer orders its walk the
  // same way, and the order is the one a reader scanning for a specific
  // loss meets it in.
  dropped.push(
    ...unknownEntryKeys(file, {
      fields: droppedFields,
      profiles: droppedProfiles,
      profileFields: droppedProfileFields,
    }),
  );

  for (const key of Object.keys(file)) {
    // BR-026-7's discipline, applied to a file whose unknown keys are more
    // likely meaningful than an our-schema file's: the store build runs
    // ahead of the published source (§4 of the research), so an unknown
    // key may be a setting this translation was never written against —
    // and "I had that set in Fake Filler and it did nothing" deserves the
    // same answer here it gets from an import.
    if (!FAKEFILLER_SCHEMA_KEYS.has(key)) {
      dropped.push({ code: 'migrateDroppedKey', params: [key] });
    }
  }

  // Shapes last, as the importer orders them: the per-entry losses name the
  // user's own fields first, the file's own structure after.
  dropped.push(...mistypedRoots(file));

  const stated = typeof file['version'] === 'number' ? file['version'] : undefined;

  return {
    settings,
    incoming: { rules: rules.length, profiles: profiles.length },
    current: { rules: current.rules.length, profiles: current.profiles.length },
    dropped,
    noted,
    sourceVersion: stated,
    versionStated: stated !== undefined,
    // BR-027-6's flag is asked of *every* translated rule, not the global
    // list alone: a backup whose only persona-backed generators live in a
    // profile — a staging profile with username and email fields, a very
    // plausible shape — draws from the fill's person exactly as a global
    // rule does, and the report's one sentence about that change is owed
    // for those rules as much as these.
    personaBacked:
      rules.some((rule) => PERSONA_BACKED.has(rule.generator.type)) ||
      profiles.some((profile) =>
        profile.rules.some((rule) => PERSONA_BACKED.has(rule.generator.type)),
      ),
  };
}

/**
 * The kind each documented root key carries (§2.2 of the research), for the
 * shape check below and for the unknown-key report.
 *
 * Two duties, one table, because the two must not be able to disagree: a key
 * added here and forgotten there would make every backup carrying it report
 * the key as unmapped while translating it happily — an accurate statement
 * about a copy of the list and a false one about the migration.
 */
const FAKEFILLER_KEY_KINDS: ReadonlyMap<string, string> = new Map([
  ['version', 'number'],
  ['fields', 'list'],
  ['profiles', 'list'],
  ['fieldMatchSettings', 'object'],
  ['ignoredFields', 'list'],
  ['agreeTermsFields', 'list'],
  ['confirmFields', 'list'],
  ['defaultMaxLength', 'number'],
  ['enableContextMenu', 'boolean'],
  ['ignoreFieldsWithContent', 'boolean'],
  ['ignoreHiddenFields', 'boolean'],
  ['passwordSettings', 'object'],
  ['triggerClickEvents', 'boolean'],
]);

/** The keys a backup may carry without being reported as unmapped (step 4). */
const FAKEFILLER_SCHEMA_KEYS: ReadonlySet<string> = new Set(FAKEFILLER_KEY_KINDS.keys());

/**
 * Root keys of the backup present with the wrong kind of value (UC-027 step 4,
 * the migration's own `mistypedShapes`).
 *
 * Every reader below is tolerant — `listAt` answers a non-list with `[]`,
 * `asRecord` with `{}`, `booleanOf` and `keywordsOf` with defaults — which is
 * right for a *missing* key (our default stands, exactly as the Translation
 * table's rows imply) and silent for a *mistyped* one. Until this existed, a
 * hand-edited backup carrying `"fields": {…}` migrated as an empty
 * configuration with an empty report: the importer called the same blindness a
 * defect and built `mistypedShapes` for it, and this use case's stated remit —
 * nothing lost silently (PD-002, FR-056, A6's own wording) — is the stronger
 * claim of the two, because a migrant cannot check the file against what the
 * reference would have done with it.
 *
 * Names the key and says what stands in for it; the migration proceeds on the
 * parts that were readable, as an import does.
 */
function mistypedRoots(file: Record<string, unknown>): readonly MigrationDrop[] {
  const drops: MigrationDrop[] = [];
  for (const [key, kind] of FAKEFILLER_KEY_KINDS) {
    if (!(key in file)) continue;
    if (kindOf(file[key]) === kind) continue;
    drops.push({ code: 'migrateDroppedShape', params: [key] });
  }
  return drops;
}

/**
 * The keys a `fields[]` entry may carry (§2.2's `ICustomField`), beyond the
 * three every entry has: `type`, `name`, `match`.
 *
 * For the unknown-key report below. The per-type options are listed rather
 * than unioned into one set, so the report names what the entry's *own type*
 * had no place for — `emailPrefix` on a `number` field is a key the schema
 * documents, carried where it means nothing, and "unrecognised" would be a
 * sentence about this translation rather than about the entry.
 */
const FIELD_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['', new Set(['type', 'name', 'match'])],
  ['first-name', new Set(['type', 'name', 'match'])],
  ['last-name', new Set(['type', 'name', 'match'])],
  ['full-name', new Set(['type', 'name', 'match'])],
  ['organization', new Set(['type', 'name', 'match'])],
  ['username', new Set(['type', 'name', 'match'])],
  ['url', new Set(['type', 'name', 'match'])],
  ['email', new Set(['type', 'name', 'match', 'emailPrefix', 'emailHostname', 'emailHostnameList', 'emailUsername', 'emailUsernameList', 'emailUsernameRegEx'])],
  ['telephone', new Set(['type', 'name', 'match', 'template'])],
  ['number', new Set(['type', 'name', 'match', 'min', 'max', 'decimalPlaces'])],
  ['date', new Set(['type', 'name', 'match', 'template', 'minDate', 'maxDate'])],
  ['text', new Set(['type', 'name', 'match', 'maxLength'])],
  ['alphanumeric', new Set(['type', 'name', 'match', 'template'])],
  ['regex', new Set(['type', 'name', 'match', 'template'])],
  ['randomized-list', new Set(['type', 'name', 'match', 'list'])],
]);

/** The keys a `profiles[]` entry may carry (§2.2's `IProfile`). */
const PROFILE_KEYS: ReadonlySet<string> = new Set(['name', 'urlMatch', 'fields']);

/**
 * Unknown keys on the entries, named rather than silently ignored (step 4,
 * FR-056, PD-002).
 *
 * The root-level reports (`migrateDroppedKey`, `mistypedRoots`) were built
 * on the argument that the store build runs ahead of the published source
 * (§4 of the research) — and that argument is *more* true one level down,
 * where a store-build field type or option would appear. The importer
 * descends into its entries for the same reason (`unknownKeys` scans
 * `rules[i].` and `profiles[i].`), and until this existed a key the
 * documented schema never mentions vanished from both lists — which is the
 * one outcome this use case's report exists to make impossible.
 *
 * Only entries that survived their own translation are scanned, for the
 * importer's reason: an entry already reported as a drop has nothing stored
 * to describe, and a second line about it would inflate the count the user
 * is deciding on. `reported` carries the indexes the loops already dropped —
 * global fields, whole profiles, *and fields inside a profile*, which the
 * global set alone does not reach — so the two walks cannot disagree about
 * which entries count.
 *
 * One shape is checked here rather than in a kind table: a profile whose
 * `fields` is not a list. The tolerant reader answers it with `[]`, which
 * used to arrive as a profile with no rules and no line in either report —
 * the user's scoped fields, silently gone. Named by path, like the importer
 * names a mistyped section inside an entry.
 */
function unknownEntryKeys(
  file: Record<string, unknown>,
  reported: {
    readonly fields: ReadonlySet<number>;
    readonly profiles: ReadonlySet<number>;
    readonly profileFields: ReadonlyMap<number, ReadonlySet<number>>;
  },
): readonly MigrationDrop[] {
  const drops: MigrationDrop[] = [];

  const scanField = (entry: unknown, index: number, prefix: string): void => {
    const record = asRecord(entry);
    const known = FIELD_KEYS.get(typeof record['type'] === 'string' ? record['type'] : '');
    if (known === undefined) return; // an unknown type is already a drop of its own
    for (const key of Object.keys(record)) {
      if (!known.has(key)) drops.push({ code: 'migrateDroppedKey', params: [`${prefix}fields[${index}].${key}`] });
    }
  };

  for (const [index, entry] of listAt(file, 'fields').entries()) {
    if (reported.fields.has(index)) continue;
    scanField(entry, index, '');
  }

  for (const [index, entry] of listAt(file, 'profiles').entries()) {
    if (reported.profiles.has(index)) continue;
    // An empty-but-object profile is named for its own shape, not picked
    // through; a garbage one is dropped whole by the caller.
    if (kindOf(entry) !== 'object') continue;
    const record = entry as Record<string, unknown>;

    if ('fields' in record && kindOf(record['fields']) !== 'list') {
      drops.push({ code: 'migrateDroppedShape', params: [`profiles[${index}].fields`] });
    }

    for (const key of Object.keys(record)) {
      if (!PROFILE_KEYS.has(key)) {
        drops.push({ code: 'migrateDroppedKey', params: [`profiles[${index}].${key}`] });
      }
    }
    const corpse = reported.profileFields.get(index);
    for (const [at, field] of listAt(record, 'fields').entries()) {
      if (corpse?.has(at)) continue;
      scanField(field, at, `profiles[${index}].`);
    }
  }

  return drops;
}

/* -------------------------------------------------------------- one field → */

/**
 * What becomes of one `fields[]` entry.
 *
 * `losses` is the second list's raw material (A3): every setting the entry
 * carried that the translated rule does not, named per rule, in the
 * user's language once the surface resolves the note's own sentence
 * around them.
 */
type FieldOutcome =
  | { readonly kind: 'rule'; readonly rule: Rule; readonly name: string; readonly losses: readonly string[] }
  | { readonly kind: 'drop'; readonly drop: FieldDrop };

/**
 * A drop before the caller has said which list it came from, because a
 * global field and a profile's field word their drops differently and
 * nothing in the decision to drop depends on where the entry was found.
 */
type FieldDrop =
  | { readonly reason: 'unreadable'; readonly name: string }
  | { readonly reason: 'noMatch'; readonly name: string }
  | { readonly reason: 'unknownType'; readonly name: string; readonly type: string }
  | { readonly reason: 'refused'; readonly name: string; readonly patterns: readonly string[]; readonly problem: RuleProblem };

function asGlobalDrops(drop: FieldDrop): readonly MigrationDrop[] {
  switch (drop.reason) {
    case 'unreadable':
      return [{ code: 'migrateDroppedField', params: [drop.name] }];
    case 'noMatch':
      return [{ code: 'migrateDroppedFieldNoMatch', params: [drop.name] }];
    case 'unknownType':
      return [{ code: 'migrateDroppedFieldUnknownType', params: [drop.name, drop.type] }];
    case 'refused':
      // BR-027-3: the report names every pattern that went into the join,
      // because "the rule" was the user's whole list, not the one pattern
      // that happened to tip it.
      return [
        {
          code: 'migrateDroppedFieldRefused',
          params: [drop.name, drop.patterns.join(' | ')],
          problem: drop.problem,
        },
      ];
  }
}

function asProfileDrops(drop: FieldDrop, profile: string): readonly MigrationDrop[] {
  switch (drop.reason) {
    case 'unreadable':
      return [{ code: 'migrateDroppedProfileField', params: [profile, drop.name] }];
    case 'noMatch':
      return [{ code: 'migrateDroppedProfileFieldNoMatch', params: [profile, drop.name] }];
    case 'unknownType':
      return [{ code: 'migrateDroppedProfileFieldUnknownType', params: [profile, drop.name, drop.type] }];
    case 'refused':
      return [
        {
          code: 'migrateDroppedProfileFieldRefused',
          params: [profile, drop.name, drop.patterns.join(' | ')],
          problem: drop.problem,
        },
      ];
  }
}

/**
 * One custom field, translated (the Translation table's `fields[]` row).
 *
 * BR-027-3 joins the reference's pattern list into one alternation rather
 * than splitting one field into several rules: several rules have an order
 * nobody chose — and precedence is behaviour (FR-031) — and a report that
 * names one entry four times. Any-of semantics survive the join exactly:
 * `(?:a)|(?:b)` matches what `a` or `b` matched, case-insensitively on
 * both sides by construction (BR-027-4).
 *
 * The joined rule then crosses the same boundary the editor applies
 * (A4, BR-026-8): the reference never screened a pattern in its life, and
 * a backup is the likeliest source of a pattern `validateRule` refuses
 * that this extension will ever see. After this it is storage, and
 * storage coerces rather than refuses — this is the last boundary.
 */
function translateField(entry: unknown, index: number, id: string): FieldOutcome {
  const record = asRecord(entry);
  const name = stringOf(record['name'], `#${String(index + 1)}`);

  const patterns = patternsOf(record['match']);
  if (patterns.length === 0) {
    return { kind: 'drop', drop: { reason: 'noMatch', name } };
  }

  const generator = translateGenerator(record);
  if (generator === undefined) {
    return { kind: 'drop', drop: unreadableField(record, name) };
  }

  // Each pattern wrapped non-capturing, so an alternation inside one
  // pattern cannot bleed into the join and a capture group cannot change
  // what the pattern matches.
  const joined = patterns.map((pattern) => `(?:${pattern})`).join('|');
  const rule: Rule = {
    id,
    label: name,
    enabled: true,
    match: { mode: 'regex', pattern: joined },
    generator: generator.generator,
    // BR-027-6: persona-backed types draw from the fill's person, which is
    // the direction this product defines as correct. Non-persona types
    // ignore the flag, so it is set unconditionally.
    fromPersona: true,
  };

  const problem = validateRule(rule)[0];
  if (problem !== undefined) {
    return { kind: 'drop', drop: { reason: 'refused', name, patterns, problem } };
  }

  return { kind: 'rule', rule, name, losses: generator.losses };
}

/** Which unreadable shape a field had, for the drop that names it. */
function unreadableField(record: Record<string, unknown>, name: string): FieldDrop {
  const type = record['type'];
  if (typeof type === 'string' && !FAKEFILLER_TYPES.has(type)) {
    return { reason: 'unknownType', name, type };
  }
  return { reason: 'unreadable', name };
}

/** The reference's documented custom-field types (§2.2 of the research). */
const FAKEFILLER_TYPES: ReadonlySet<string> = new Set([
  'alphanumeric',
  'date',
  'email',
  'first-name',
  'full-name',
  'last-name',
  'number',
  'organization',
  'randomized-list',
  'regex',
  'telephone',
  'text',
  'url',
  'username',
]);

/**
 * One field's generator, or `undefined` when the entry cannot become one
 * at all.
 *
 * The losses each branch collects are the Translation table's "what it
 * costs" column, named per rule (A3). Absence from a branch's loss list is
 * deliberate and means the mapping is exact (BR-027-4).
 */
function translateGenerator(
  record: Record<string, unknown>,
): { readonly generator: Generator; readonly losses: readonly string[] } | undefined {
  const losses: string[] = [];
  const type = record['type'];

  switch (type) {
    case 'first-name':
      return { generator: { type: 'name', part: 'first' }, losses };
    case 'last-name':
      return { generator: { type: 'name', part: 'last' }, losses };
    case 'full-name':
      return { generator: { type: 'name', part: 'full' }, losses };
    // The reference's spelling, not ours; both name an organisation and
    // the mapping is exact.
    case 'organization':
      return { generator: { type: 'organisation' }, losses };
    case 'username':
    case 'url':
      return { generator: { type }, losses };

    case 'email': {
      // The reference's email customisation is real work the user did — a
      // chosen hostname list, a chosen prefix — and ours has nowhere to
      // put any of it: addresses draw from the persona so they match the
      // name beside them. Named, every key the entry actually carried,
      // because "not supported" must not read as "not noticed" (A3, and
      // A6's password sentence is the same argument one flow later).
      for (const key of [
        'emailPrefix',
        'emailHostname',
        'emailHostnameList',
        'emailUsername',
        'emailUsernameList',
        'emailUsernameRegEx',
      ]) {
        if (key in record) losses.push(key);
      }
      return { generator: { type: 'email' }, losses };
    }

    case 'telephone': {
      // Ours draws from the persona's telephone numbers, which stay
      // coherent with the record; the reference's template has no
      // equivalent and is named only when the entry carries one.
      if (typeof record['template'] === 'string' && record['template'] !== '') {
        losses.push(`template "${record['template']}"`);
      }
      return { generator: { type: 'telephone' }, losses };
    }

    case 'number': {
      const min = bounded(record['min'], 0, GENERATOR_BOUNDS.number, 'min', losses);
      const max = bounded(record['max'], 100, GENERATOR_BOUNDS.number, 'max', losses);
      const decimals = bounded(
        record['decimalPlaces'],
        0,
        GENERATOR_BOUNDS.decimals,
        'decimalPlaces',
        losses,
      );
      const [low, high] = min <= max ? [min, max] : [max, min];
      if (min > max) losses.push('min and max reordered');
      return { generator: { type: 'number', min: low, max: high, decimals }, losses };
    }

    case 'date': {
      const template = record['template'];
      const format =
        typeof template === 'string' && template !== ''
          ? translateDateTemplate(template, losses)
          : DEFAULT_DATE_FORMAT;
      // Bounds translate when they parse as dates; otherwise the default
      // range stands and the bound is named. `Date.parse` is loose enough
      // that a moment-style "DD/MM/YYYY" string can land on the wrong side
      // of a slash, so only strict ISO is accepted — a bound the backup
      // meant as 1 March reading as 3 January is a silent behaviour
      // change, and BR-027-5 has that number.
      const from = isoOr('minDate', record['minDate'], DEFAULT_DATE_FROM, losses);
      const to = isoOr('maxDate', record['maxDate'], DEFAULT_DATE_TO, losses);
      return { generator: { type: 'date', format, from, to }, losses };
    }

    case 'text': {
      // A per-field `maxLength` has no word-count equivalent: ours sizes
      // text by words, the reference's by characters, and importing the
      // cap verbatim would change what the rule *is* rather than lose a
      // setting. Our default sizing stands and the cap is named.
      if (typeof record['maxLength'] === 'number') losses.push(`maxLength ${String(record['maxLength'])}`);
      return { generator: { type: 'text', minWords: 5, maxWords: 20 }, losses };
    }

    case 'alphanumeric': {
      const template = record['template'];
      if (typeof template !== 'string' || template === '') return undefined;
      const translated = translateAlphanumeric(template, losses);
      if (translated === '') return undefined;
      return { generator: { type: 'alphanumeric', template: translated }, losses };
    }

    case 'regex': {
      const pattern = record['template'];
      if (typeof pattern !== 'string' || pattern === '') return undefined;
      // Whatever A4 refuses: `validateRule` on the finished rule runs both
      // the generatable-subset and the backtracking checks, worded exactly
      // as the editor words them.
      return { generator: { type: 'regex', pattern }, losses };
    }

    case 'randomized-list': {
      const items = stringsOf(record['list']);
      if (items.length === 0) return undefined;
      return { generator: { type: 'list', items }, losses };
    }

    default:
      return undefined;
  }
}

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
const DEFAULT_DATE_FROM = '1970-01-01';
const DEFAULT_DATE_TO = '2035-12-31';

/**
 * One numeric setting, clamped to the bounds our parser enforces.
 *
 * The clamp is applied here rather than left to `parseSettings` on the
 * write, because the plan is what the user confirms: a bound the storage
 * would quietly move belongs in the report, named as arriving changed,
 * before the write — not discovered by diffing storage afterwards. Same
 * values, same bounds, one report.
 */
function bounded(
  value: unknown,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
  name: string,
  losses: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
  if (clamped !== value) {
    losses.push(`${name} ${String(value)} → ${String(clamped)}`);
  }
  return clamped;
}

/** A date bound: strict ISO from the backup, or our default, named. */
function isoOr(name: string, value: unknown, fallback: string, losses: string[]): string {
  if (typeof value !== 'string') return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return value;
  }
  losses.push(`${name} "${value}"`);
  return fallback;
}

/* ------------------------------------------------------- template translation */

/**
 * A moment-style date template, translated token by token.
 *
 * Exact tokens carried with no loss (BR-027-4): `YYYY YY MMM MM DD HH mm
 * ss`. Bracketed literals `[x]` become the literal `x`, which both
 * grammars mean and ours needs no escaping for. Everything else becomes
 * the nearest token or nothing, always named — see the module note for why
 * "pass through as a literal" cannot be taken literally, `MMMM` being the
 * case that cannot be represented at all.
 */
function translateDateTemplate(template: string, losses: string[]): string {
  let out = '';

  let index = 0;
  while (index < template.length) {
    const character = template.charAt(index);

    // Moment's literal escape. Ours needs no escape, so the content is the
    // literal — exact, not a loss, though its own braces must be doubled
    // to survive our grammar.
    if (character === '[') {
      const close = template.indexOf(']', index);
      const content = close === -1 ? template.slice(index + 1) : template.slice(index + 1, close);
      out += escapeTemplateLiteral(content);
      index = close === -1 ? template.length : close + 1;
      continue;
    }

    // Only moment's token letters start a token; everything else — the `T`
    // of an ISO timestamp, an `at` between date and time, every `/` and
    // `:` and space — is a literal. Treating any letter as a token run
    // would have eaten the separators, and `DD/MM/YYYY` would have arrived
    // as `DDMMYYYY` with two named "losses" nobody lost.
    if (!MOMENT_TOKEN_LETTERS.has(character)) {
      out += escapeTemplateLiteral(character);
      index += 1;
      continue;
    }

    // A run of one repeated token letter is one moment token, read whole —
    // `MMM` is never `MM` plus a literal `M`.
    let run = character;
    while (run.length < 8 && template.charAt(index + run.length) === character) run += character;

    out += dateToken(run, losses);
    index += run.length;
  }

  return out;
}

/** The letters moment's format grammar reads as tokens (its own table, §2.2). */
const MOMENT_TOKEN_LETTERS: ReadonlySet<string> = new Set(['Y', 'M', 'D', 'H', 'h', 'm', 's', 'S', 'A', 'a', 'X', 'x']);

/** One moment token's nearest equivalent in our grammar, with its loss named. */
function dateToken(run: string, losses: string[]): string {
  switch (run) {
    // Exact — carried with no loss and no flag (BR-027-4: what maps
    // exactly is stated as mapping exactly, by not being here at all).
    case 'YYYY':
    case 'YY':
    case 'MMM':
    case 'MM':
    case 'DD':
    case 'HH':
    case 'mm':
    case 'ss':
      return run;

    default: {
      // Nearest or nothing, named either way. The nearest is chosen per
      // family — a run of `M` pads to `MM`, a 12-hour `h` widens to `HH`
      // and says so — and the genuinely homeless (`A`, `X`, `SSS`, a
      // lone letter our grammar would substitute through) contribute
      // nothing rather than junk.
      const head = run[0];
      const nearest =
        head === 'Y' ? 'YYYY'
        : head === 'M' ? (run.length >= 4 ? 'MMM' : 'MM')
        : head === 'D' ? 'DD'
        : head === 'H' || head === 'h' ? 'HH'
        : head === 'm' ? 'mm'
        : head === 's' ? 'ss'
        : undefined;

      losses.push(`date token ${JSON.stringify(run)}`);
      return nearest ?? '';
    }
  }
}

/**
 * An alphanumeric template, translated character by character.
 *
 * Exact placeholders (`L l D c v x`), nearest placeholders named (`C V X`
 * lose their case or their nonzero-ness), `[…]` literals verbatim, and
 * everything else a literal in our grammar — which is the reference's own
 * rule for unknown characters and therefore exact rather than a guess.
 */
function translateAlphanumeric(template: string, losses: string[]): string {
  let out = '';

  let index = 0;
  while (index < template.length) {
    const character = template.charAt(index);

    if (character === '[') {
      const close = template.indexOf(']', index);
      const content = close === -1 ? template.slice(index + 1) : template.slice(index + 1, close);
      out += escapeTemplateLiteral(content);
      index = close === -1 ? template.length : close + 1;
      continue;
    }

    switch (character) {
      case 'L':
        out += '{upper}';
        break;
      case 'l':
        out += '{lower}';
        break;
      // "Either case letter" is exactly our mixed-case `{letter}`.
      case 'D':
        out += '{letter}';
        break;
      case 'c':
        out += '{consonant}';
        break;
      case 'v':
        out += '{vowel}';
        break;
      case 'x':
        out += '{digit}';
        break;
      // Upper consonants and vowels have no case in ours, and `X` may
      // produce a zero; each maps to the nearest placeholder and is named.
      case 'C':
        out += '{consonant}';
        losses.push('C (uppercase consonant)');
        break;
      case 'V':
        out += '{vowel}';
        losses.push('V (uppercase vowel)');
        break;
      case 'X':
        out += '{digit}';
        losses.push('X (nonzero digit)');
        break;
      default:
        out += escapeTemplateLiteral(character);
        break;
    }

    index += 1;
  }

  return out;
}
/** Literal text our template grammar can hold: braces doubled, all else as-is. */
function escapeTemplateLiteral(text: string): string {
  return text.replaceAll('{', '{{').replaceAll('}', '}}');
}

/* ---------------------------------------------------------- root sections → */

/**
 * The behaviour section (the Translation table's middle rows).
 *
 * Every row is "the reference's name for a setting ours keeps under
 * another name", except `defaultMaxLength`, which is the one row where
 * importing verbatim would import a *defect*: the reference's single
 * global cap is what ND-10 exists to replace — it gives an unconstrained
 * textarea twenty characters — so the cap lands on the single-line kinds
 * only and the report says so.
 */
function translateBehaviour(
  file: Record<string, unknown>,
  dropped: MigrationDrop[],
  noted: MigrationNote[],
): Settings['behaviour'] {
  const behaviour = {
    ...DEFAULT_SETTINGS.behaviour,
    // A fresh object rather than the default's own: the plan is a state
    // the user confirms and storage holds, and a reference to a constant's
    // interior is one mutation away from rewriting the shipped defaults
    // for the lifetime of this page.
    maxLengths: {} as Settings['behaviour']['maxLengths'],
    dispatchEvents: booleanOf(file['triggerClickEvents'], DEFAULT_SETTINGS.behaviour.dispatchEvents),
    skipHidden: booleanOf(file['ignoreHiddenFields'], DEFAULT_SETTINGS.behaviour.skipHidden),
    skipPreFilled: booleanOf(
      file['ignoreFieldsWithContent'],
      DEFAULT_SETTINGS.behaviour.skipPreFilled,
    ),
  };

  const cap = file['defaultMaxLength'];
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
    const length = Math.trunc(cap);
    // Alphabetical keys, for a hazard the export path already guards against
    // and this path now shares: `chrome.storage.local` hands a stored state
    // back with every object's keys alphabetised, and `maxLengths` is the one
    // record whose keys are *data* — chosen per kind — so the parser re-emits
    // it in whatever order storage gave. A plan whose caps are not already
    // alphabetical is therefore not stable across the write: the echo of the
    // page's own write comes back reordered, fails the page's is-this-ours
    // comparison, and the adoption announcement talks over the migration's
    // own. `settings-file.ts` sorts its caps for the same reason (BR-025-3's
    // measured behaviour, one module over).
    behaviour.maxLengths = { search: length, text: length };
    noted.push({ code: 'migrateNotedDefaultMaxLength', params: [String(length)] });
  }

  // Each list on its own answer, and a total loss named where it happens:
  // an unreadable keyword list keeps the shipped words rather than
  // manufacturing "tick nothing for consent" out of garbage, and the drop
  // says which list it was (`keywordsOf`'s comment, the boundary).
  const consent = keywordsOf(file['agreeTermsFields'], DEFAULT_SETTINGS.behaviour.consentKeywords);
  if (consent.unreadable) dropped.push({ code: 'migrateDroppedShape', params: ['agreeTermsFields'] });
  behaviour.consentKeywords = consent.keywords;

  const confirmation = keywordsOf(
    file['confirmFields'],
    DEFAULT_SETTINGS.behaviour.confirmationKeywords,
  );
  if (confirmation.unreadable) {
    dropped.push({ code: 'migrateDroppedShape', params: ['confirmFields'] });
  }
  behaviour.confirmationKeywords = confirmation.keywords;

  return behaviour;
}

/**
 * The keyword lists, split on commas.
 *
 * The reference stores these as arrays whose entries may themselves be
 * comma-joined — its UI parses a CSV box into the array, and hand-edited
 * backups carry both shapes — so each entry is split again, which is exact
 * for the documented shape and tolerant of the other without ever
 * inventing a keyword.
 */
/**
 * A keyword list, split on commas, with the total-loss case made visible.
 *
 * Three readings, and the boundary between the last two is the whole fix:
 * an absent or non-list value falls back to the shipped words (the root
 * shape check names the non-list case); an *explicitly emptied* list stays
 * empty, per the parser's own rule — "tick nothing for consent" is a
 * configuration, not an accident to undo; and a **non-empty list from which
 * no keyword can be read** is neither. Until this distinguished them, `[42]`
 * or `["  "]` manufactured an empty consent list out of garbage — silently
 * switching off every terms checkbox the user's configuration ticked, which
 * is a fill-behaviour change wearing a successful translation's face
 * (PD-002). Such a list is unreadable rather than empty, so the caller keeps
 * the default and names the key.
 *
 * Partial garbage is carried past: `["agree,", 42]` yields `["agree"]` with
 * nothing said, because blank fragments between commas are normal CSV
 * hygiene — the reference's own UI parsed a box — and a stray non-string
 * beside readable keywords loses nothing the user can act on. Only the
 * total loss changes what a fill does.
 */
function keywordsOf(stored: unknown, fallback: readonly string[]): {
  readonly keywords: readonly string[];
  /** A non-empty list from which no keyword could be read. */
  readonly unreadable: boolean;
} {
  if (!Array.isArray(stored)) return { keywords: fallback, unreadable: false };

  const split = stored
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const unreadable = stored.length > 0 && split.length === 0;
  return { keywords: unreadable ? fallback : split, unreadable };
}

/**
 * The password policy (the table's two password rows).
 *
 * Random mode keeps our classes at the observed random length of eight —
 * the reference's generator makes an 8-character token, so eight is the
 * number its user has been watching password fields receive. Defined mode
 * is A6: our passwords are generated under a policy and fitted to the
 * field's own constraints (ND-11), and there is nowhere in the schema to
 * put a chosen string. Dropped and named, because a QA workflow that
 * relied on a known password is genuinely changed by migrating, and the
 * user should meet that fact here rather than at the login screen.
 */
function translatePasswords(
  file: Record<string, unknown>,
  dropped: MigrationDrop[],
  noted: MigrationNote[],
): Settings['passwords'] {
  const settings = asRecord(file['passwordSettings']);
  const mode = settings['mode'];

  if (mode === 'random') {
    noted.push({ code: 'migrateNotedPasswordRandom', params: [] });
    return { ...defaultPolicy(), length: 8 };
  }

  if (mode === 'defined') {
    dropped.push({ code: 'migrateDroppedPasswordDefined', params: [] });
    // The policy itself still arrives — password fields are still filled,
    // under our defaults rather than the chosen string the report names.
    return defaultPolicy();
  }

  // Absent or unrecognised mode: the reference's own default is the
  // defined string, but a backup that states neither is a hand-edit, and
  // guessing the defined drop for it would name a loss the file does not
  // carry. Our policy stands, said nothing about.
  return defaultPolicy();
}

/**
 * The shipped policy, as a fresh object — never `DEFAULT_SETTINGS`' own, for
 * the reason `translateBehaviour` states one function over: the plan is a
 * state the user confirms and other code then holds, and a reference into
 * the constant's interior is one mutation away from rewriting the shipped
 * defaults for the lifetime of this page. Inert while every writer spreads
 * and storage re-parses on the way in, which is exactly why it gets fixed
 * before the writer that forgets arrives.
 */
function defaultPolicy(): Settings['passwords'] {
  return { ...DEFAULT_SETTINGS.passwords };
}

/**
 * The matching sources (the `fieldMatchSettings` row, BR-027-7).
 *
 * The user's toggles are preserved as they set them — including `class`,
 * which ours ships off because it is the noisiest source to author
 * against: overriding an explicit choice with our default would be
 * precisely the quiet configuration loss this use case exists to prevent,
 * and would leave the report naming the dropped email hostname while
 * silently switching off half the matching the rules depend on.
 *
 * `matchAriaLabel` and `matchAriaLabelledBy` both feed our one `ariaLabel`
 * source, because the reference resolved `labelledby` to text and
 * compared it in the same pass; if the backup disagrees with itself, ours
 * is on — the wider of the two, and therefore the one that cannot lose a
 * match the reference made — and the split is named.
 *
 * `testId` has no counterpart and stays at our default, unstated: nothing
 * was lost, because the reference never had it.
 */
function translateSources(stored: Record<string, unknown>, noted: MigrationNote[]): SourceToggles {
  const sources = { ...DEFAULT_SOURCES };

  const pairs: readonly (readonly [string, keyof SourceToggles])[] = [
    ['matchName', 'name'],
    ['matchId', 'id'],
    ['matchClass', 'className'],
    ['matchLabel', 'label'],
    ['matchPlaceholder', 'placeholder'],
  ];
  for (const [theirs, ours] of pairs) {
    if (theirs in stored) sources[ours] = booleanOf(stored[theirs], sources[ours]);
  }

  if ('matchAriaLabel' in stored || 'matchAriaLabelledBy' in stored) {
    const label = booleanOf(stored['matchAriaLabel'], true);
    const labelledBy = booleanOf(stored['matchAriaLabelledBy'], true);
    if (label !== labelledBy) {
      noted.push({ code: 'migrateNotedSourcesSplit', params: [] });
    }
    sources.ariaLabel = label || labelledBy;
  }

  return sources;
}

const DEFAULT_SOURCES = DEFAULT_SETTINGS.sources;

/* ------------------------------------------------------------------ helpers */

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A field's `match` list: the patterns that decide what it applies to. */
function patternsOf(stored: unknown): readonly string[] {
  return Array.isArray(stored)
    ? stored.filter((pattern): pattern is string => typeof pattern === 'string' && pattern !== '')
    : [];
}

function stringsOf(stored: unknown): readonly string[] {
  return Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listAt(value: Record<string, unknown>, key: string): readonly unknown[] {
  const list = value[key];
  return Array.isArray(list) ? list : [];
}
