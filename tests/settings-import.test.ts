import { describe, expect, it } from 'vitest';
import { analyseImport, MAX_IMPORT_SIZE, SCHEMA_VERSION } from '@/lib/settings-import';
import { serialiseSettings } from '@/lib/settings-file';
import { DEFAULT_SETTINGS, type Rule, type Settings } from '@/lib/settings';

/**
 * UC-026's analysis: what an import would do, before it does it.
 *
 * The failure this file is really guarding against is A5's, and it is worth
 * naming because every other part of the system would call it a success. The
 * tolerant parser cannot fail — handed an object it does not recognise it
 * returns a complete, valid, entirely default configuration — so a user
 * importing the wrong file would be told the import worked, and would find out
 * what it cost them on the next page they filled. Every refusal below exists
 * because silence at this boundary is data loss (BR-026-3).
 */

const rule = (id: string, extra: Partial<Rule> = {}): Rule => ({
  id,
  label: `Rule ${id}`,
  enabled: true,
  match: { mode: 'contains', pattern: id },
  generator: { type: 'email' },
  fromPersona: true,
  ...extra,
});

const configured = (): Settings => ({
  ...DEFAULT_SETTINGS,
  locale: 'de-CH',
  rules: [rule('a'), rule('b')],
  profiles: [
    { id: 'p1', label: 'Staging', enabled: true, urls: ['https://staging.example.com/*'], rules: [rule('p1r1')] },
  ],
});

/** The current configuration an import would be replacing, in most cases below. */
const current = (): Settings => ({ ...DEFAULT_SETTINGS, rules: [rule('existing')] });

const analyse = (file: unknown, now: Settings = current()) =>
  analyseImport(JSON.stringify(file), now);

describe('refusing a file', () => {
  it('refuses text that is not JSON, with the parser’s own complaint (A1)', () => {
    const outcome = analyseImport('{ not json', current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedNotJson');
    expect(outcome.refusal.params[0]).toBeTruthy();
  });

  it('refuses JSON that is not an object (A1)', () => {
    // Separated from the syntax failure because the correction is different:
    // this file parsed perfectly and still is not a configuration.
    for (const value of [[], 42, 'settings', null]) {
      const outcome = analyse(value);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.refusal.code).toBe('importRefusedNotObject');
    }
  });

  it('refuses a file from a newer schema, naming both versions (A2)', () => {
    const outcome = analyse({ ...configured(), version: SCHEMA_VERSION + 1 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedNewer');
    expect(outcome.refusal.params).toEqual([String(SCHEMA_VERSION + 1), String(SCHEMA_VERSION)]);
  });

  it('refuses on the version before asking whether the contents are ours (A2 before A5)', () => {
    // A newer file whose sections this build cannot name must be refused for its
    // version, not for its contents: the user's fix is a newer extension, and
    // "nothing in this file is ours" would send them looking for the wrong one.
    const outcome = analyse({ version: SCHEMA_VERSION + 1, somethingNew: true });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedNewer');
  });

  it('refuses a file with no section of ours in it (A5, BR-026-4)', () => {
    // Shaped like a backup from another form filler: plausible, structured, and
    // holding nothing this schema can name.
    const outcome = analyse({
      fields: [{ type: 'text', name: 'email' }],
      ignoredFields: ['captcha'],
      defaultMaxLength: 20,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedNothingOurs');
  });

  it('refuses a file holding nothing but a version number (BR-026-4)', () => {
    // `version` describes a configuration rather than carrying one, so it does
    // not make a file ours. Were it enough, any file that happened to use the
    // same key name would import a full set of defaults over the user's rules
    // and report success.
    const outcome = analyse({ version: SCHEMA_VERSION });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedNothingOurs');
  });

  it('accepts a file whose only section is empty', () => {
    // The counterpart to the rule above: `{"rules": []}` carries a section, and
    // an empty rule list is a configuration someone can have meant.
    const outcome = analyse({ version: SCHEMA_VERSION, rules: [] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.incoming.rules).toBe(0);
  });
});

describe('planning an import', () => {
  it('reads back what UC-025 wrote, whole', () => {
    // The pair's central claim, from the other end: what the exporter produces
    // is what this reads. `tests/settings-file.test.ts` makes the same check
    // through the parser; this one makes it through the importer, including its
    // refusals, so neither can drift without a failure here.
    const outcome = analyseImport(serialiseSettings(configured()), current());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings).toEqual(configured());
    expect(outcome.plan.dropped).toEqual([]);
    expect(outcome.plan.migrated).toBe(false);
  });

  it('shows both sides of the replacement (BR-026-5)', () => {
    const outcome = analyse(configured(), current());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.current).toEqual({ rules: 1, profiles: 0 });
    expect(outcome.plan.incoming).toEqual({ rules: 2, profiles: 1 });
  });

  it('replaces rather than merges (BR-026-1)', () => {
    const outcome = analyse({ version: SCHEMA_VERSION, rules: [] }, current());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The rule that is there now is not in the plan. A merge would be a rule
    // list in an order nobody authored, and order is precedence (FR-031).
    expect(outcome.plan.settings.rules).toEqual([]);
  });

  it('takes the file’s defaults for a section the file omits (BR-026-1)', () => {
    const outcome = analyse(
      { version: SCHEMA_VERSION, rules: [] },
      { ...current(), passwords: { ...DEFAULT_SETTINGS.passwords, length: 40 } },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.passwords.length).toBe(DEFAULT_SETTINGS.passwords.length);
  });

  it('changes nothing until it is applied', () => {
    // An analysis is a read. Stated as a test because the whole design rests on
    // it: the plan is shown, and only a confirmation writes.
    const now = current();
    const before = JSON.stringify(now);
    analyse(configured(), now);

    expect(JSON.stringify(now)).toBe(before);
  });
});

describe('naming what will not be kept', () => {
  it('names a rule the parser cannot read, by its label (A6)', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [rule('kept'), { label: 'Broken rule', match: { mode: 'contains', pattern: 'x' } }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.incoming.rules).toBe(1);
    expect(outcome.plan.dropped).toContainEqual({
      code: 'importDroppedRule',
      params: ['Broken rule'],
    });
  });

  it('falls back to the pattern, then to the position, when there is no label', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ match: { mode: 'contains', pattern: 'postcode' } }, { nothing: true }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.map((drop) => drop.params[0])).toEqual(
      expect.arrayContaining(['postcode', '#2']),
    );
  });

  it('names a dropped rule inside a profile that survives (A6)', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [
        { id: 'p1', label: 'Staging', urls: [], rules: [rule('ok'), { label: 'Bad one' }] },
      ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.incoming.profiles).toBe(1);
    expect(outcome.plan.dropped).toContainEqual({
      code: 'importDroppedProfileRule',
      params: ['Staging', 'Bad one'],
    });
  });

  it('names a whole profile the parser cannot read', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [{ label: 'No identifier', urls: [] }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toContainEqual({
      code: 'importDroppedProfile',
      params: ['No identifier'],
    });
  });

  it('names keys this build does not know, by path (BR-026-7)', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...rule('a'), colour: 'red' }],
      behaviour: { ...DEFAULT_SETTINGS.behaviour, wobble: 3 },
      somethingElse: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual(
      expect.arrayContaining([
        { code: 'importDroppedKey', params: ['somethingElse'] },
        { code: 'importDroppedKey', params: ['behaviour.wobble'] },
        { code: 'importDroppedKey', params: ['rules[0].colour'] },
      ]),
    );
  });

  it('names a section whose value is not a section (UC-026 step 4)', () => {
    // The case that made the report blind: `record(3)` is `{}` and `{}` has no
    // unknown keys in it, so before the shape check this imported as every
    // behaviour setting reset, with an empty drop list and `ok: true`.
    for (const given of [3, 'hello', null, [] as unknown]) {
      const outcome = analyse({ version: SCHEMA_VERSION, behaviour: given });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.dropped).toEqual([{ code: 'importDroppedShape', params: ['behaviour'] }]);
      expect(outcome.plan.settings.behaviour).toEqual(DEFAULT_SETTINGS.behaviour);
    }
  });

  it('names a field of a section whose value is the wrong kind', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      exclusions: { fields: '^cvv$', domains: [] },
      passwords: { ...DEFAULT_SETTINGS.passwords, length: '20' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual(
      expect.arrayContaining([
        { code: 'importDroppedShape', params: ['exclusions.fields'] },
        { code: 'importDroppedShape', params: ['passwords.length'] },
      ]),
    );
    expect(outcome.plan.settings.exclusions.fields).toEqual([]);
  });

  it('reports a wrongly shaped rules list without inventing entries', () => {
    const outcome = analyse({ version: SCHEMA_VERSION, rules: { a: 1 } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([{ code: 'importDroppedShape', params: ['rules'] }]);
    expect(outcome.plan.incoming.rules).toBe(0);
  });

  it('does not name array indices as keys the user added', () => {
    // `record` hands an array back unchanged, so scanning a section given as a
    // list would report `exclusions.0` — an index dressed up as a hand-added
    // key, on top of the honest report that the section is not a section.
    const outcome = analyse({ version: SCHEMA_VERSION, exclusions: ['^cvv$'] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([{ code: 'importDroppedShape', params: ['exclusions'] }]);
  });

  it('says nothing about a shape the schema does keep there', () => {
    const outcome = analyse(JSON.parse(serialiseSettings(configured())));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([]);
  });

  it('does not call the pre-DD-005 flat keys unknown (A4)', () => {
    // The parser reads these from the top level, so a file carrying them is
    // being understood rather than tolerated. Reporting them as dropped would
    // name keys that were in fact kept.
    const outcome = analyse({ dispatchEvents: false, skipHidden: false, ignorePatterns: ['^cvv$'] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([]);
    expect(outcome.plan.settings.behaviour.dispatchEvents).toBe(false);
    expect(outcome.plan.settings.exclusions.fields).toEqual([{ mode: 'regex', pattern: '^cvv$' }]);
    expect(outcome.plan.migrated).toBe(true);
  });

  it('reports a file with no version as migrated (A4)', () => {
    const outcome = analyse({ rules: [] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.migrated).toBe(true);
  });

  it('names a field of a rule whose value is the wrong kind (BR-026-7)', () => {
    // The shape check used to stop at the root, where the shipped defaults hold
    // no rule to compare a field against. `sources` is the field that made the
    // silence expensive: a string is not a list, `parseSourceList` answers it
    // with `undefined`, and `undefined` means "whatever is enabled globally" —
    // so a rule pinned to one source arrives matching all seven, reported as a
    // clean import.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...rule('pinned'), sources: 'name' }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toContainEqual({
      code: 'importDroppedShape',
      params: ['rules[0].sources'],
    });
    expect(outcome.plan.settings.rules[0]?.sources).toBeUndefined();
  });

  it('names a field of a profile whose value is the wrong kind (BR-026-7)', () => {
    // Both losses are total and both were silent: a profile whose `rules` is not
    // a list arrives with no rules in it, and one whose `urls` is a bare string
    // matches no page at all. Neither shows up in the summary's counts, which
    // do not break out a profile's own rules.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [{ id: 'p1', label: 'Staging', urls: 'https://staging.example.com/*', rules: 42 }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual(
      expect.arrayContaining([
        { code: 'importDroppedShape', params: ['profiles[0].urls'] },
        { code: 'importDroppedShape', params: ['profiles[0].rules'] },
      ]),
    );
    expect(outcome.plan.settings.profiles[0]?.urls).toEqual([]);
    expect(outcome.plan.settings.profiles[0]?.rules).toEqual([]);
  });

  it('says nothing about a rule whose fields are all the right kind', () => {
    // The other half of the two above, and the one that guards the witness
    // itself: the shapes those compare against are taken from the parser rather
    // than written out, so a witness that came back empty would report nothing
    // at all and every check above would pass with it.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...rule('a'), sources: ['name', 'id'] }],
      profiles: [{ id: 'p1', label: 'Staging', urls: ['https://x/*'], rules: [rule('b')] }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([]);
  });
});

/**
 * BR-026-8 — the importer is the only writer of rules that is not the editor.
 *
 * FR-070 rejects a rule when it is saved, and until this existed a file was a
 * way round that: well-shaped is not the same as valid, so a rule the editor
 * refuses beside the field it was typed into imported without comment. The
 * pattern below is the reason the rule is a safety rule rather than a
 * consistency one — `compileRules` compiles it once per fill and `selectRule`
 * runs it against identity text the page controls, in the background worker.
 */
describe('refusing a rule the editor would not save', () => {
  const backtracking = { ...rule('redos'), label: 'Catastrophic', match: { mode: 'regex', pattern: '(a+)+b' } };

  it('does not store a catastrophically backtracking pattern (NFR-009)', () => {
    const outcome = analyse({ version: SCHEMA_VERSION, rules: [rule('fine'), backtracking] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules.map((kept) => kept.id)).toEqual(['fine']);
    expect(outcome.plan.incoming.rules).toBe(1);
  });

  it('names it with the fault itself, not as a file it could not read (A6)', () => {
    // The distinction the user acts on: there is nothing wrong with this file's
    // syntax, and "could not be read" would send them to correct it.
    const outcome = analyse({ version: SCHEMA_VERSION, rules: [backtracking] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [drop] = outcome.plan.dropped;
    expect(drop?.code).toBe('importDroppedRuleRefused');
    expect(drop?.params).toEqual(['Catastrophic']);
    expect(drop?.problem?.code).toBe('ruleProblemPatternBacktracks');
  });

  it('separates a rule it cannot read from one it will not store', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ label: 'Unreadable' }, backtracking],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.map((drop) => drop.code)).toEqual([
      'importDroppedRule',
      'importDroppedRuleRefused',
    ]);
  });

  it('refuses one inside a profile that survives, naming the profile', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [{ id: 'p1', label: 'Staging', urls: [], rules: [rule('ok'), backtracking] }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.profiles[0]?.rules.map((kept) => kept.id)).toEqual(['ok']);
    const [drop] = outcome.plan.dropped;
    expect(drop?.code).toBe('importDroppedProfileRuleRefused');
    expect(drop?.params).toEqual(['Staging', 'Catastrophic']);
    expect(drop?.problem?.code).toBe('ruleProblemPatternBacktracks');
  });

  it('applies every check the editor applies, not only the pattern', () => {
    // Nothing here is about regular expressions: an unreadable template, a date
    // range that starts after it ends and a rule pinned to no source at all are
    // each refused beside the field that fixes them, and each imported clean
    // before this. Two neighbours of theirs are deliberately absent, because the
    // parser already refuses them and they arrive as `importDroppedRule`: an
    // empty list generator is not a list generator at all, and `parseGenerator`
    // sorts a number range's two bounds so an impossible one cannot exist. This
    // handles what the parser deliberately does not.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [
        {
          ...rule('template'),
          label: 'Bad template',
          generator: { type: 'alphanumeric', template: '{nosuchthing}' },
        },
        {
          ...rule('range'),
          label: 'Backwards',
          generator: { type: 'date', format: 'YYYY-MM-DD', from: '2030-01-01', to: '2020-01-01' },
        },
        { ...rule('nowhere'), label: 'No sources', sources: [] },
      ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toEqual([]);
    expect(outcome.plan.dropped.map((drop) => drop.problem?.code)).toEqual([
      'ruleProblemTemplateInvalid',
      'ruleProblemDateRange',
      'ruleProblemNoSources',
    ]);
  });

  it('does not report a refused rule twice over its own field shapes', () => {
    // A rule that is not being stored has no defaults anyone will reach, so a
    // shape note about it would be describing something that never happens.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...backtracking, fromPersona: 'yes' }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toHaveLength(1);
  });
});

describe('naming what arrives faulty and is kept anyway (A8)', () => {
  const exclusion = (pattern: string, mode = 'regex') => ({
    version: SCHEMA_VERSION,
    exclusions: { fields: [{ mode, pattern }], domains: [] },
  });

  it('imports a catastrophically backtracking exclusion and says so', () => {
    // The asymmetry this closes: the identical pattern in `rules` is refused and
    // named, and until 2026-08-24 the same six characters in `exclusions.fields`
    // arrived with an empty drop list and nothing said anywhere.
    const outcome = analyse(exclusion('(a+)+b'));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([]);
    expect(outcome.plan.settings.exclusions.fields).toEqual([{ mode: 'regex', pattern: '(a+)+b' }]);
    const [note] = outcome.plan.noted;
    expect(note?.code).toBe('importNotedExclusion');
    expect(note?.params).toEqual(['(a+)+b']);
    expect(note?.problem.code).toBe('ruleProblemPatternBacktracks');
  });

  it('names one that will not compile', () => {
    const outcome = analyse(exclusion('(unclosed'));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.noted.map((note) => note.problem.code)).toEqual(['ruleProblemPatternInvalid']);
    // Kept, because the exclusion editor keeps a half-typed pattern on purpose
    // (UC-005 A5) and an import must not be stricter than the screen that
    // authors them. The agent skips it at fill time with the rest of the list
    // intact.
    expect(outcome.plan.settings.exclusions.fields).toHaveLength(1);
  });

  it('says nothing about a pattern that is not a regex', () => {
    // `contains` and `exact` are escaped before they are compiled, so there is
    // no syntax to get wrong — a note here would be a warning about nothing.
    expect(analysedNotes(exclusion('(a+)+b', 'contains'))).toEqual([]);
    expect(analysedNotes(exclusion('(a+)+b', 'exact'))).toEqual([]);
  });

  it('says nothing about a healthy configuration', () => {
    expect(analysedNotes(serialisedDefaults())).toEqual([]);
  });

  it('does not report an exclusion the parser refused outright', () => {
    // A blank pattern never reaches the plan, so it is `dropped`'s to report if
    // anything is. Naming it in both lists would have them contradict each
    // other about whether it arrived.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      exclusions: { fields: [{ mode: 'regex', pattern: '' }], domains: [] },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.exclusions.fields).toEqual([]);
    expect(outcome.plan.noted).toEqual([]);
  });
});

function analysedNotes(file: unknown): readonly string[] {
  const outcome = analyse(file);
  if (!outcome.ok) throw new Error('the file was refused');
  return outcome.plan.noted.map((note) => note.code);
}

function serialisedDefaults(): unknown {
  return JSON.parse(serialiseSettings(configured()));
}

describe('refusing a file too big to be one of ours (A9)', () => {
  /** A file of the given length that is otherwise a perfectly good import. */
  const padded = (length: number): string => {
    const settings = { version: SCHEMA_VERSION, rules: [rule('kept')], locale: 'en-US' };
    const text = JSON.stringify(settings);
    // Padding inside a string value, so the file stays valid JSON and the
    // refusal is provably about size rather than about shape.
    const padding = 'x'.repeat(Math.max(0, length - text.length - 12));
    return JSON.stringify({ ...settings, label: padding });
  };

  it('refuses before it parses, naming the size and the bound', () => {
    const outcome = analyseImport(padded(MAX_IMPORT_SIZE + 1024), current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedTooLarge');
    const [size, limit] = outcome.refusal.params;
    expect(Number(limit)).toBe(MAX_IMPORT_SIZE / 1024);
    expect(Number(size)).toBeGreaterThan(Number(limit));
  });

  it('reads a file that is merely large', () => {
    // The bound is a sanity check on a file nobody here wrote, not a limit on
    // how much configuration a user may have: ten times the scale NFR-024 names
    // serialises to under 4 MB, and this is bigger than that and still read.
    const outcome = analyseImport(padded(MAX_IMPORT_SIZE - 1024), current());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toHaveLength(1);
  });

  it('refuses on size before it refuses on anything else', () => {
    // An oversized file that is *also* not JSON. Size wins, because the other
    // answer is only available after the work this is here to avoid.
    const outcome = analyseImport('{ not json'.padEnd(MAX_IMPORT_SIZE + 1, ' '), current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('importRefusedTooLarge');
  });
});

describe('reporting one loss once', () => {
  it('does not pick over an unreadable rule for what else was wrong with it', () => {
    // Both halves are true of this entry — it cannot be read, and it carries a
    // key this version does not have — and only the first is worth a line: the
    // rule is not arriving, so an unknown key inside it describes nothing that
    // will ever be stored, and counting it twice inflates the number the user
    // is deciding on.
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ label: 'Broken rule', junk: 1 }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([{ code: 'importDroppedRule', params: ['Broken rule'] }]);
  });

  it('nor a rule it read and refuses to store', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...rule('redos'), label: 'Catastrophic', match: { mode: 'regex', pattern: '(a+)+b' }, junk: 1 }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.map((drop) => drop.code)).toEqual(['importDroppedRuleRefused']);
  });

  it('nor the rules inside a profile that was itself dropped', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [{ label: 'No id, so not a profile', junk: 1, rules: [{ label: 'inner', junk: 2 }] }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.map((drop) => drop.code)).toEqual(['importDroppedProfile']);
  });

  it('still names an unknown key inside a rule it is keeping', () => {
    // The other direction, and the one that makes the skip a rule about losses
    // rather than a way of saying less: this rule arrives, so a key the file put
    // inside it is a key that silently did nothing (BR-026-7).
    const outcome = analyse({
      version: SCHEMA_VERSION,
      rules: [{ ...rule('kept'), junk: 1 }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([{ code: 'importDroppedKey', params: ['rules[0].junk'] }]);
  });

  it('and one inside a surviving profile whose rule was dropped', () => {
    const outcome = analyse({
      version: SCHEMA_VERSION,
      profiles: [{ id: 'p1', label: 'Staging', urls: [], junk: 1, rules: [{ label: 'inner', junk: 2 }] }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.map((drop) => `${drop.code}:${drop.params.join('/')}`)).toEqual([
      'importDroppedProfileRule:Staging/inner',
      'importDroppedKey:profiles[0].junk',
    ]);
  });
});
