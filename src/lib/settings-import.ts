import { DEFAULT_SETTINGS, MATCH_SOURCES, parseSettings, type Rule, type Settings } from './settings';
import { validateMatcher, validateRule, type RuleProblem } from './rules/validate';
import { profileName } from './profiles';
import { decodeBackupTransport, looksLikeFakeFiller } from './fakefiller-recognise';
import { listAt, recordOf } from './coerce';

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
 *
 * **Readable is not the same as storable, and this is the only other writer.**
 * The parser says what a state *is*; FR-070 says what may be written, and the
 * two are not the same set — `(a+)+b` is a perfectly well-shaped match pattern
 * and the editor refuses it beside the field it was typed into, because
 * `compileRules` compiles it once per fill and `selectRule` then runs it against
 * identity text the *page* controls (NFR-009). Nothing between a file and
 * storage applied that check, so a file could store a rule no editor would
 * write, and `validate.ts` and the settings store both already said this module
 * was where it happens. It now does: `validateRule` runs on every rule the
 * parser hands back, a rule that fails is named in `dropped` with its own fault,
 * and `settings` is what is left. The module's one invariant is unchanged —
 * `settings` is what would be stored, exactly.
 *
 * **Field exclusions are named rather than refused**, which is the third stance
 * here and the one the other two make necessary. The exclusion editor stores a
 * pattern while it is still invalid on purpose (UC-005 A5: a half-typed pattern
 * is invalid on the way to being valid, and refusing it would lose the
 * keystroke), so dropping one here would make an import stricter than the screen
 * that authors them — a different defect, not a fix. Saying *nothing* was the
 * other extreme, and it is what this module did until 2026-08-24: `(a+)+b` as an
 * exclusion imported with an empty drop list, while the identical pattern in a
 * rule was named with its fault. One `validateMatcher`, one file, two answers.
 * They are now reported in `noted` — kept, stored, and stated before the write,
 * which is what BR-026-3 asks for and what the exclusion list already does
 * beside every row.
 *
 * **A rule can also arrive *changed* rather than faulty, and that is reported
 * too** (A10). `validateRule` is asked about the rule as it *would be stored*,
 * which is the only rule there is to judge — and it means the parser has already
 * reordered a reversed range or replaced an unreadable date field by the time
 * the question is put. So `{ min: 50, max: 10 }`, which the editor refuses
 * outright, imported clean with the bounds swapped. Refusing it here would make
 * an import stricter than storage, which reads the same file the same way on
 * every load; saying nothing left the promise above — one function decides what
 * the editor writes and what an import stores — true only of the rules the
 * parser did not quietly fix first. `coercedGenerator` closes that by comparing
 * the file's own values against the stored ones, which is observation rather
 * than a second opinion: naming a value *wrong* would need a rule, naming it
 * *changed* needs only both sides.
 */

/** The schema version this build writes and reads. */
export const SCHEMA_VERSION = DEFAULT_SETTINGS.version;

/**
 * The largest file this will look at, measured rather than chosen (A9).
 *
 * Everything below runs on the options page's own thread: the file is read into
 * a string, `JSON.parse` walks it, and the analysis walks it again — and a
 * pending file is re-analysed on every render, so the cost is paid more than
 * once. None of that is bounded by anything in the file itself, and the file is
 * the one input here that nobody wrote for this extension.
 *
 * Measured on 2026-08-24, against configurations serialised by `settings-file`:
 *
 *   NFR-024's own scale, 500 rules                     0.31 MB    4 ms
 *   500 rules + 50 profiles × 20 + 200 exclusions      1.05 MB    9 ms
 *   ten times NFR-024, plus all of the above           3.86 MB   32 ms
 *   8 MB of the smallest entries a file can hold      8.00 MB  ~100 ms
 *
 * The last row is the one that sets the bound: minimal entries buy the most
 * *entries* per byte, and every entry costs a `parseSettings` call in
 * `verdictOn`, so it is the worst shape a file of a given size can have. At the
 * bound it costs about a tenth of a second, which is a real cost for a
 * deliberate action and not a freeze.
 *
 * So 8 MB: twice the largest configuration anyone could plausibly hold, and an
 * order of magnitude above the scale the requirements name. A file past it is
 * refused *before* it is read, which is the only place a refusal is worth
 * anything — the damage of a 500 MB file is done by `text()` and `JSON.parse`,
 * long before any of this could have an opinion about its contents.
 */
export const MAX_IMPORT_SIZE = 8 * 1024 * 1024;

/**
 * The refusal for a file past that bound, worded in one place.
 *
 * Exported because two callers reach the bound from different sides and must say
 * the same thing: the options page checks `File.size`, in bytes, before reading
 * anything, and `analyseImport` below checks the text it was handed, in UTF-16
 * code units. The two differ only for non-ASCII content and only by a factor a
 * sanity bound does not care about — but the *message* must not differ, and a
 * second copy of it is how that happens.
 */
export function oversizeRefusal(observed: number): ImportRefusal {
  const kilobytes = (size: number): string => String(Math.ceil(size / 1024));
  return { code: 'importRefusedTooLarge', params: [kilobytes(observed), kilobytes(MAX_IMPORT_SIZE)] };
}

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
    | 'importRefusedTooLarge'
    | 'importRefusedNotJson'
    | 'importRefusedNotObject'
    | 'importRefusedNewer'
    | 'importRefusedNothingOurs'
    | 'importRefusedFakeFiller';
  readonly params: readonly string[];
};

/** One thing the file carried that the import will not keep (BR-026-3, A6, BR-026-7). */
export type ImportDrop = {
  readonly code:
    | 'importDroppedRule'
    | 'importDroppedRuleRefused'
    | 'importDroppedProfile'
    | 'importDroppedProfileRule'
    | 'importDroppedProfileRuleRefused'
    | 'importDroppedKey'
    | 'importDroppedShape';
  readonly params: readonly string[];
  /**
   * The fault behind the two `…Refused` codes, carried rather than worded.
   *
   * A `RuleProblem` is already a catalog key and its substitutions, for the same
   * reason `code` above is one — so the surface resolves the fault and drops it
   * into the drop's own sentence, and this module still says nothing in English.
   * The alternative was a drop that read "could not be read" about a rule that
   * was read perfectly well and refused for a reason the user is entitled to.
   *
   * The first fault only. A refused rule is not being corrected here the way it
   * would be in the editor, where every problem is listed beside the field that
   * fixes it; this is a line in a list saying why one entry of a file is not
   * arriving, and the first reason is enough to make it findable.
   */
  readonly problem?: RuleProblem;
};

/**
 * One thing the import *will* store that carries a fault with it (BR-026-3).
 *
 * A separate list from `dropped`, because the two make opposite promises and a
 * reader has to be able to tell them apart without reading the wording: a drop
 * is an entry that will not be there afterwards, and a note is an entry that
 * will. Folding these into `dropped` was the obvious economy and it would have
 * made every line of that list mean "either gone or not, see the sentence" —
 * which is the one thing the preview exists to be precise about.
 *
 * The fault is carried rather than worded, exactly as a refused rule's is: a
 * `RuleProblem` is a catalog key and its substitutions, so the surface resolves
 * it and this module still says nothing in English (NFR-018).
 */
export type ImportNote = {
  readonly code:
    | 'importNotedExclusion'
    | 'importNotedRuleCoerced'
    | 'importNotedProfileRuleCoerced'
    | 'importNotedDuplicateId'
    | 'importNotedProfileDuplicateId';
  readonly params: readonly string[];
  /**
   * The first fault only, for the reason a drop carries only its first: this is
   * a line in a list making a problem findable, not the editor listing every
   * problem beside the field that fixes it. The exclusion list does that, and it
   * is where this line is sending the user.
   *
   * Absent for a note whose fault is not a *rule's*. Two entries sharing an id
   * is a contradiction between them rather than a property of either, so there
   * is nothing for `validateRule` to have said about it and nothing to carry:
   * the note's own sentence is the whole of it.
   */
  readonly problem?: RuleProblem;
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
  /** Entries the plan would store that are faulty, kept and named (BR-026-3). */
  readonly noted: readonly ImportNote[];
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
  // Derived, not restated: a source added to `MATCH_SOURCES` and forgotten here
  // would make every exported file report that source as dropped — an accurate
  // statement about this table and a false one about the import, which writes it
  // faithfully. `testId` arrived and did exactly that, in this project's own
  // round-trip test.
  ['sources', new Set<string>(MATCH_SOURCES)],
  ['triggers', new Set(['contextMenu'])],
];

/**
 * A rule and a profile with every field present and of the kind the schema keeps
 * there, for the shape check below.
 *
 * Taken from the parser rather than written out here, for the reason
 * `SECTION_KEYS` and the `sources` row are derived: a table of field types
 * copied out by hand is a second statement of the schema, and the one that goes
 * out of date is always the copy. Feeding the parser a minimal entry and keeping
 * what it hands back gives a witness that cannot disagree with it — the same
 * argument `mistypedShapes` makes for reading root shapes off `DEFAULT_SETTINGS`,
 * which holds no rule and no profile to read these from.
 *
 * The rule states `sources` explicitly because that field is optional and a
 * witness without it would have nothing to compare against — which is exactly
 * the field whose wrong shape is worst: `parseSourceList` answers a string with
 * `undefined`, and `undefined` means "whatever is enabled globally", so a rule
 * pinned to one source arrives on the importing machine matching all of them.
 */
const RULE_WITNESS: Record<string, unknown> = {
  ...parseSettings({
    rules: [{ match: { mode: 'contains', pattern: 'x' }, generator: { type: 'email' }, sources: [] }],
  }).rules[0],
};
const PROFILE_WITNESS: Record<string, unknown> = {
  ...parseSettings({ profiles: [{ id: 'x' }] }).profiles[0],
};

/**
 * Reads a file and works out what importing it would do.
 *
 * The order of the checks is the order of the use case's steps, and it is load
 * bearing in both directions. A file from a newer schema is refused on its
 * version (A2, step 3) before anything asks whether its contents are
 * recognisable (A5, step 4) — a newer file whose sections this build cannot
 * name would otherwise be refused for the wrong reason, and the user would be
 * told their file is not ours when what it actually needs is a newer extension.
 * And a Fake Filler backup is recognised before its version is even read,
 * because the backup's `version` describes the reference's schema, not ours,
 * and a version number borrowed from another product is not ours to refuse on.
 */
export function analyseImport(text: string, current: Settings): ImportOutcome {
  // A9, and it is first because every line after it is unbounded work on a file
  // nobody here wrote. The options page refuses an oversized file before reading
  // it; this is the same bound for every other caller, and for the case where
  // the two disagree — a `File` whose reported size is not what `text()` yielded.
  if (text.length > MAX_IMPORT_SIZE) {
    return { ok: false, refusal: oversizeRefusal(text.length) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A Fake Filler backup arrives as Base64, and a migrant who points this
    // section at one has made a natural mistake, not a file error — so the
    // transport is decoded for recognition only. Whatever it decodes to, it
    // is not this schema's JSON, and the not-JSON refusal below remains the
    // answer for everything the recogniser cannot claim.
    const decoded = decodeBackupTransport(text.trim());
    if (decoded !== undefined) {
      try {
        const inner: unknown = JSON.parse(decoded);
        if (looksLikeFakeFiller(inner)) return refuse('importRefusedFakeFiller', []);
      } catch {
        // Not JSON inside the transport either: the not-JSON refusal names
        // the outer failure, which is the one the user can see.
      }
    }
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

  // A5 / BR-026-4, sharpened by UC-027's owed pointer. The tolerant parser
  // cannot fail: handed an object it does not recognise, it returns a
  // complete and entirely default configuration, so the import would
  // report success and the user would have lost everything they had.
  //
  // A Fake Filler backup is the one unrecognised file with a name and a
  // destination, and it gets its own refusal for it rather than the
  // generic one: recognition runs on the reference's documented key set,
  // so a migrant is told where to go instead of told their file is
  // nothing.
  //
  // **Before the version check**, because a backup's `version` describes
  // the reference's schema, not ours — a Fake Filler export carrying
  // version 2 is not "from a newer version of the settings format", and
  // refusing it as one would name a reason that is not true. Recognition
  // on keys rather than on failure-to-be-ours is what makes both refusals
  // honest at once.
  if (looksLikeFakeFiller(file)) {
    return refuse('importRefusedFakeFiller', []);
  }

  // A2. Refused, never coerced, and ND-13 forbids an override. Coercing forward
  // discards what this build cannot name, from a file that may be the only copy
  // — and neither we nor the user could see what went.
  if (stated !== undefined && stated > SCHEMA_VERSION) {
    return refuse('importRefusedNewer', [String(stated), String(SCHEMA_VERSION)]);
  }

  if (!SECTION_KEYS.some((key) => key in file)) {
    return refuse('importRefusedNothingOurs', []);
  }

  const settings = storable(parseSettings(file));
  const shapes = mistypedShapes(file);
  const entries = droppedEntries(file);
  return {
    ok: true,
    plan: {
      settings,
      incoming: { rules: settings.rules.length, profiles: settings.profiles.length },
      current: { rules: current.rules.length, profiles: current.profiles.length },
      dropped: [
        ...entries.drops,
        ...unknownKeys(file, shapes.mistyped, entries.reported),
        ...shapes.drops,
      ],
      noted: [...notedExclusions(settings), ...entries.notes, ...notedDuplicateIds(settings)],
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
 * Field exclusions that will be stored and will not do what they say (UC-005 A5,
 * BR-026-3).
 *
 * Read off the *plan*, not off the file, and that is the whole design of it:
 * `settings` is what would be stored, so a note is a statement about the state
 * the user is agreeing to rather than about the text they chose. A file whose
 * exclusion the parser refused outright — a blank pattern, an entry of the wrong
 * shape — never reaches here, because it is not in the plan to be noted; it is
 * `dropped`'s to report, and reporting it twice in two lists that promise
 * opposite things is worse than reporting it once.
 *
 * `validateMatcher` is asked, never re-implemented — the same function the
 * exclusion editor asks and, through `validateRule`, the same one that refuses a
 * rule's pattern. So a pattern cannot be storable in one of the three and
 * faulty in another, which is the property the module note at the top spends its
 * length defending.
 */
function notedExclusions(settings: Settings): readonly ImportNote[] {
  const notes: ImportNote[] = [];
  for (const matcher of settings.exclusions.fields) {
    const problem = validateMatcher(matcher)[0];
    if (problem !== undefined) {
      notes.push({ code: 'importNotedExclusion', params: [matcher.pattern], problem });
    }
  }
  return notes;
}

/**
 * Rules the plan would store that claim to be the same rule (BR-010-2).
 *
 * A rule's id is its identity to every editor operation: `replaceRule` maps
 * *all* matches and `removeRule` filters all, so two rules sharing one give the
 * user a list where editing the first relabels both and deleting the first
 * deletes both. Fills are unaffected — matching walks the list in order and
 * takes the first hit — so nothing else in the system can notice this, and
 * nothing else will tell them.
 *
 * Only a file can produce it. The editor mints a fresh id per rule, and since
 * 2026-08-24 the parser's fallback for a rule that states none is unique by
 * position — what is left is a file that *repeats* an id, which a parser has no
 * business rewriting: it is the file saying two entries are the same rule. So it
 * is named here, which is what `parseRule`'s own comment has promised since the
 * fallback changed, and until now did not deliver.
 *
 * Noted rather than dropped, on the same terms as a faulty exclusion: both rules
 * arrive, and refusing one would be choosing which of the two the user meant.
 *
 * Per list, because that is the scope an id has to be unique in — the rule
 * editor works through a lens over one list at a time, so a global rule and a
 * profile's rule sharing an id is not a collision anything can act on.
 */
function notedDuplicateIds(settings: Settings): readonly ImportNote[] {
  const notes: ImportNote[] = [];

  for (const [id, names] of collisions(settings.rules)) {
    notes.push({ code: 'importNotedDuplicateId', params: [names.join('; '), id] });
  }

  for (const [index, profile] of settings.profiles.entries()) {
    for (const [id, names] of collisions(profile.rules)) {
      notes.push({
        code: 'importNotedProfileDuplicateId',
        params: [profileName(profile) ?? `#${String(index + 1)}`, names.join('; '), id],
      });
    }
  }

  return notes;
}

/** Ids held by more than one rule in a list, each with the rules holding it. */
function collisions(rules: readonly Rule[]): ReadonlyMap<string, readonly string[]> {
  const byId = new Map<string, string[]>();
  for (const [index, rule] of rules.entries()) {
    const held = byId.get(rule.id) ?? [];
    held.push(ruleName(rule, index));
    byId.set(rule.id, held);
  }
  return new Map([...byId].filter(([, held]) => held.length > 1));
}

/**
 * What to call a stored rule in a report line.
 *
 * `nameOf` above answers the same question about a *file entry*; this one is its
 * counterpart for a rule that made it through the parser, and it falls back the
 * same way for the same reason. A comment here used to claim the label was
 * enough — "it falls back to the pattern in the parser, so it is never the empty
 * string here" — which is true of a rule that states *no* label and false of one
 * that states an empty one: `parseRule` keeps a stated `""` rather than
 * replacing it, because an empty label is a thing a user can type in the editor
 * and get back. The note then read "Rules ; Postcode share one identity", which
 * is the one line in this report that can come out unreadable.
 */
function ruleName(rule: Rule, index: number): string {
  if (rule.label.trim() !== '') return rule.label;
  return rule.match.pattern.trim() === '' ? `#${String(index + 1)}` : rule.match.pattern;
}

/**
 * What the plan would actually store: read by the parser, allowed by FR-070.
 *
 * The filter is the second half of the module note at the top, and it has to
 * happen here rather than in the report, because `settings` is the plan — the
 * user confirms this state, and a rule named as dropped that then arrived in
 * storage would make every other line of the report worthless too.
 *
 * `validateRule` is asked, never re-implemented, exactly as `parseSettings` is:
 * one function decides what the editor will write and what an import will store,
 * so the two cannot come to disagree about the same rule.
 */
function storable(parsed: Settings): Settings {
  return {
    ...parsed,
    rules: parsed.rules.filter(allowed),
    profiles: parsed.profiles.map((profile) => ({
      ...profile,
      rules: profile.rules.filter(allowed),
    })),
  };
}

function allowed(rule: Rule): boolean {
  return validateRule(rule).length === 0;
}

/**
 * Every rule and profile in the file that the import will not store, and what
 * survives it holding a field of the wrong kind.
 *
 * Each entry is put to `parseSettings` **on its own**, inside an otherwise empty
 * state, and kept or dropped according to what comes back. Asking the real
 * parser one entry at a time is what makes this a report rather than a second
 * opinion: there is no rule here about what makes a rule readable, so there is
 * nothing to fall out of step with `parseRule`.
 *
 * Identity is deliberately not used to match survivors against the file's
 * entries. A file can state the same `id` on two rules — nothing stops it, and
 * `parseRule` reads what it is given rather than renaming one — so a diff keyed
 * on identity would report a survivor as dropped. That was true of the id-less
 * case too until 2026-08-24, when the fallback stopped being the bare pattern;
 * the argument outlived the example, because the fallback was never what made
 * identity unsafe to key on. A file is not obliged to be consistent.
 *
 * One pass per entry, reporting all three things that can be wrong with it,
 * because they are ordered rather than independent: a rule the parser could not
 * read has no fields worth checking the shape of and nothing to validate, and a
 * rule FR-070 refuses is not going to be stored, so naming its wrongly shaped
 * `sources` too would be describing a default that is never reached.
 */
function droppedEntries(file: Record<string, unknown>): {
  readonly drops: readonly ImportDrop[];
  /**
   * Rules that arrive with values the parser changed (BR-026-3).
   *
   * Collected on this walk rather than on a second one, because the comparison
   * needs the file entry and the stored rule side by side and this is the only
   * place that has both.
   */
  readonly notes: readonly ImportNote[];
  /**
   * The entries this already reported as losses, by the path prefix
   * `unknownKeys` would scan them under.
   *
   * Handed on rather than recomputed, because the question "was this entry
   * dropped?" is answered here by asking the parser and would have to be asked
   * again — a second walk over the same entries, agreeing with this one by
   * construction until the day it did not.
   */
  readonly reported: ReadonlySet<string>;
} {
  const drops: ImportDrop[] = [];
  const notes: ImportNote[] = [];
  const reported = new Set<string>();

  for (const [index, entry] of listAt(file, 'rules').entries()) {
    const path = `rules[${index}].`;
    const verdict = verdictOn(entry, path);
    switch (verdict.kept) {
      case 'unreadable':
        drops.push({ code: 'importDroppedRule', params: [nameOf(entry, index)] });
        reported.add(path);
        break;
      case 'refused':
        drops.push({
          code: 'importDroppedRuleRefused',
          params: [nameOf(entry, index)],
          problem: verdict.problem,
        });
        reported.add(path);
        break;
      case 'stored':
        drops.push(...verdict.mistyped);
        if (verdict.coerced.length > 0) {
          notes.push({
            code: 'importNotedRuleCoerced',
            params: [verdict.name, verdict.coerced.join('; ')],
          });
        }
        break;
    }
  }

  for (const [index, entry] of listAt(file, 'profiles').entries()) {
    const path = `profiles[${index}].`;
    if (parseSettings({ profiles: [entry] }).profiles.length !== 1) {
      drops.push({ code: 'importDroppedProfile', params: [nameOf(entry, index)] });
      // The profile and everything under it. Its rules are not being stored
      // either, and they are not being reported one by one — the profile's own
      // line is the loss.
      reported.add(path);
      continue;
    }

    drops.push(...mistypedFields(entry, PROFILE_WITNESS, path));

    // The profile survives; its own rules go through the same parser and the
    // same validation and can be dropped individually, which the profile's count
    // alone would hide.
    for (const [at, rule] of listAt(recordOf(entry), 'rules').entries()) {
      const rulePath = `${path}rules[${at}].`;
      const verdict = verdictOn(rule, rulePath);
      switch (verdict.kept) {
        case 'unreadable':
          drops.push({
            code: 'importDroppedProfileRule',
            params: [nameOf(entry, index), nameOf(rule, at)],
          });
          reported.add(rulePath);
          break;
        case 'refused':
          drops.push({
            code: 'importDroppedProfileRuleRefused',
            params: [nameOf(entry, index), nameOf(rule, at)],
            problem: verdict.problem,
          });
          reported.add(rulePath);
          break;
        case 'stored':
          drops.push(...verdict.mistyped);
          if (verdict.coerced.length > 0) {
            notes.push({
              code: 'importNotedProfileRuleCoerced',
              params: [nameOf(entry, index), verdict.name, verdict.coerced.join('; ')],
            });
          }
          break;
      }
    }
  }

  return { drops, notes, reported };
}

/**
 * What becomes of one rule in the file, and why.
 *
 * Three outcomes rather than a boolean, because the two ways of losing a rule
 * are not the same thing to the user: one file said something this build cannot
 * read, the other said something this build reads perfectly and will not write.
 * Telling a user their `(a+)+b` rule "could not be read" would be false, and
 * would send them to fix a file that has nothing wrong with its syntax.
 *
 * The caller supplies the message codes, because those are all that differ
 * between a rule at the top level and the same rule inside a profile — a
 * profile's rule is named with the profile, and no other part of this decision
 * knows or cares where the rule was found.
 */
type RuleVerdict =
  | { readonly kept: 'unreadable' }
  | { readonly kept: 'refused'; readonly problem: RuleProblem }
  | {
      readonly kept: 'stored';
      readonly mistyped: readonly ImportDrop[];
      /** Generator values the parser changed on the way in, as `key was → is`. */
      readonly coerced: readonly string[];
      readonly name: string;
    };

/**
 * What becomes of one rule in the file, and why.
 *
 * `validateRule` is asked about the rule *as it would be stored*, which is the
 * only rule there is to have an opinion about — but it means the answer can be
 * "fine" about a file the editor would have refused, because the parser fixed it
 * first. `{ type: 'number', min: 50, max: 10 }` is `ruleProblemNumberRange` in
 * the editor and a clean import with the bounds swapped, and until 2026-08-24
 * nothing said so. `coerced` is that difference, observed rather than judged: it
 * compares what the file stated against what the parser produced, so it needs no
 * second opinion about what a valid generator is and cannot fall out of step
 * with one.
 */
function verdictOn(entry: unknown, path: string): RuleVerdict {
  const rule = parseSettings({ rules: [entry] }).rules[0];
  if (rule === undefined) return { kept: 'unreadable' };

  const problem = validateRule(rule)[0];
  if (problem !== undefined) return { kept: 'refused', problem };

  return {
    kept: 'stored',
    mistyped: mistypedFields(entry, RULE_WITNESS, path),
    coerced: coercedGenerator(entry, rule),
    name: ruleName(rule, 0),
  };
}

/**
 * Generator values the file stated and the plan will not store (BR-026-3).
 *
 * The generator is the one part of a rule with no shape check over it:
 * `mistypedFields` compares a rule's own keys against a witness, and both sides
 * have an *object* at `generator`, so nothing descends into it. What is inside
 * is coerced in two different ways — `min`/`max` and `minWords`/`maxWords` are
 * reordered, `date`'s three fields are replaced with defaults when they are not
 * strings — while `list`, `alphanumeric`, `regex` and `constant` refuse and take
 * the whole rule with them. That inconsistency is `parseGenerator`'s and this
 * does not try to correct it; it reports the half that arrives changed, which is
 * the half nothing else can see.
 *
 * A value comparison, not a rule: anything the file stated for a key the stored
 * generator also has, where the two differ. Kind is not consulted, because a
 * `format` of `42` and a `min` of `50` are the same event from the user's side —
 * the file said one thing and storage will hold another.
 *
 * A key the stored generator does *not* have is left alone. That is a key this
 * version has no place for, which is BR-026-7's subject rather than this one's —
 * and `unknownKeys` does not descend into a generator either, so it is a gap
 * both of them leave. It is named in UC-026's notes rather than papered over
 * here.
 */
function coercedGenerator(entry: unknown, stored: Rule): readonly string[] {
  const stated = recordOf(recordOf(entry)['generator']);
  const kept = stored.generator as unknown as Record<string, unknown>;

  const changes: string[] = [];
  for (const [key, value] of Object.entries(stated)) {
    if (!(key in kept)) continue;
    const after = kept[key];
    // JSON on both sides so a list is compared by contents rather than by
    // reference, and so the report shows `"YYYY-MM-DD"` rather than an
    // unquoted string that reads like a field name.
    if (JSON.stringify(value) === JSON.stringify(after)) continue;
    changes.push(`${key} ${JSON.stringify(value)} → ${JSON.stringify(after)}`);
  }
  return changes;
}

/**
 * Sections and fields whose value is not the kind the schema keeps there
 * (UC-026 step 4, BR-026-7).
 *
 * The tolerant parser answers a wrongly shaped value with the default for that
 * place, and until this existed the report said nothing at all about it:
 * `recordOf(3)` is `{}` and `{}` has no unknown keys in it, so both halves of the
 * analysis looked at an empty shape and found nothing to say. `{"behaviour": 3}`
 * imported as every behaviour setting silently reset, reported as a clean
 * import with an empty drop list — the loss step 5 exists to make visible,
 * reached by the one input that made the report blind.
 *
 * **What shape the schema keeps is read off `DEFAULT_SETTINGS`, not restated
 * here.** The defaults hold a value of the right kind in every place the schema
 * defines, which makes them a witness that cannot drift from the schema the way
 * a table of types written out here would — the same argument `SECTION_KEYS` and
 * the `sources` row make against restating what can be derived. A key with no
 * witness is left alone: the pre-DD-005 flat keys have no home in the current
 * defaults, and `unknownKeys` already speaks for whatever the schema cannot name.
 *
 * This is a check on *shape* and nothing more. A value of the right kind and the
 * wrong content — `locale: "xx"`, an exclusion whose regex will not compile — is
 * the parser's business, and reporting it from here would mean keeping a second
 * copy of the parser's rules, which the note at the top of this file refuses.
 * The ladder FR-073 asks for is what would report those; until it exists they
 * are coerced silently, as A3 already says. A rule refused by FR-070 is the one
 * exception and is not one of these: it is not coerced, it is not stored, and
 * `droppedEntries` names it with the fault itself.
 *
 * Root sections only. The same check inside a rule or a profile is
 * `mistypedFields`, called from the walk that already knows which entries
 * survive — a shape note about a rule that is not being stored would be
 * describing a default nothing ever reaches.
 */
function mistypedShapes(file: Record<string, unknown>): {
  readonly drops: readonly ImportDrop[];
  /** Root sections reported here, which `unknownKeys` must not descend into. */
  readonly mistyped: ReadonlySet<string>;
} {
  const drops: ImportDrop[] = [];
  const mistyped = new Set<string>();
  const defaults: Record<string, unknown> = { ...DEFAULT_SETTINGS };

  for (const [key, given] of Object.entries(file)) {
    const witness = defaults[key];
    if (witness === undefined || valueKind(given) === valueKind(witness)) continue;
    drops.push({ code: 'importDroppedShape', params: [key] });
    mistyped.add(key);
  }

  for (const [section] of SECTION_SHAPES) {
    if (mistyped.has(section)) continue;
    drops.push(...mistypedFields(file[section], recordOf(defaults[section]), `${section}.`));
  }

  return { drops, mistyped };
}

/**
 * The fields of one shape whose value is not the kind the witness holds there.
 *
 * The same comparison for a section, a rule and a profile, because it is the
 * same question asked three times — and because the rule and profile halves
 * arrived late. Until they did, the report descended into a rule only to check
 * its *key names*: `rules[0].sources: "name"` was a key the build knows holding
 * a value the schema does not keep, so both halves of the analysis looked at it
 * and neither had anything to say. It imported as a clean rule that quietly
 * matched every source instead of the one it named, and
 * `profiles[0].rules: 42` imported as a profile with no rules in it at all.
 *
 * A key with no witness is left alone: `unknownKeys` is what speaks for a name
 * the schema cannot place, and saying it twice in two different ways would make
 * the count in step 5 an overstatement.
 */
function mistypedFields(
  value: unknown,
  witness: Record<string, unknown>,
  path: string,
): readonly ImportDrop[] {
  const drops: ImportDrop[] = [];
  for (const [key, given] of Object.entries(recordOf(value))) {
    const expected = witness[key];
    if (expected === undefined || valueKind(given) === valueKind(expected)) continue;
    drops.push({ code: 'importDroppedShape', params: [`${path}${key}`] });
  }
  return drops;
}

/**
 * What kind of value this is, for the comparison above.
 *
 * `null` and arrays are separated from `object` because `typeof` calls all three
 * the same thing and the schema never does: a section given as `null` and one
 * given as `[]` are both total losses, and both would pass a `typeof` check
 * against a section the schema keeps as an object.
 *
 * Exported for the migration's shape check, which asks the same question about
 * the reference's backup keys for the same reason — one kind-of comparison, so
 * "what counts as a list" cannot be answered one way for an import and another
 * for a migration.
 */
export function valueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  return typeof value;
}

/**
 * BR-026-7: keys this build does not know, named rather than silently ignored.
 *
 * Reported by path — `behaviour.wobble`, `rules[2].colour` — so that "I added
 * that by hand and it did nothing" has an answer. It descends only into shapes
 * the schema defines; an unknown key's own contents are not explored, because
 * nothing below an unrecognised name has a meaning to report against, and
 * neither are sections `mistypedShapes` has already spoken for.
 */
function unknownKeys(
  file: Record<string, unknown>,
  mistyped: ReadonlySet<string>,
  reported: ReadonlySet<string>,
): readonly ImportDrop[] {
  const drops: ImportDrop[] = [];

  const scan = (value: unknown, known: ReadonlySet<string>, path: string): void => {
    for (const key of Object.keys(recordOf(value))) {
      if (!known.has(key)) drops.push({ code: 'importDroppedKey', params: [`${path}${key}`] });
    }
  };

  scan(file, ROOT_KEYS, '');
  for (const [section, known] of SECTION_SHAPES) {
    // A section already reported for its shape is not descended into. `record`
    // hands back an array unchanged, so scanning `exclusions: ["a"]` would name
    // `exclusions.0` — an array index dressed up as a key the user typed, on
    // top of the honest report that the section is not a section at all.
    if (mistyped.has(section)) continue;
    scan(file[section], known, `${section}.`);
  }

  // An entry already reported as a loss is not picked over for what else was
  // wrong with it. `mistypedFields` has always worked this way — a rule that is
  // not being stored has no defaults anyone will reach, so a note about its
  // field shapes describes something that never happens — and this pass was the
  // exception that made the rule look like a preference: `{label: "Broken",
  // junk: 1}` with no generator was named twice, once as a rule that could not
  // be read and once as an unknown key inside it, which inflates the count the
  // user is deciding on and answers a question nobody asked about a rule that is
  // not arriving.
  //
  // The same skip covers a dropped profile's rules, by prefix: the profile's own
  // line is the loss, and its rules were never reported individually either.
  for (const [index, rule] of listAt(file, 'rules').entries()) {
    const path = `rules[${index}].`;
    if (reported.has(path)) continue;
    scan(rule, RULE_KEYS, path);
  }

  for (const [index, profile] of listAt(file, 'profiles').entries()) {
    const path = `profiles[${index}].`;
    if (reported.has(path)) continue;
    scan(profile, PROFILE_KEYS, path);
    for (const [at, rule] of listAt(recordOf(profile), 'rules').entries()) {
      const rulePath = `${path}rules[${at}].`;
      if (reported.has(rulePath)) continue;
      scan(rule, RULE_KEYS, rulePath);
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
  const candidate = recordOf(entry);
  const label = candidate['label'];
  if (typeof label === 'string' && label.trim() !== '') return label;

  const pattern = recordOf(candidate['match'])['pattern'];
  if (typeof pattern === 'string' && pattern.trim() !== '') return pattern;

  return `#${index + 1}`;
}
