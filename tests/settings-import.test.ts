import { describe, expect, it } from 'vitest';
import { analyseImport, SCHEMA_VERSION } from '@/lib/settings-import';
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
});
