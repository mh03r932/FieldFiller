import { describe, expect, it } from 'vitest';
import {
  addRule,
  changeGeneratorType,
  defaultGenerator,
  moveRule,
  newRule,
  removeRule,
  replaceRule,
  restoreRule,
  sampleRule,
} from '@/lib/rules/editing';
import { validateRule } from '@/lib/rules/validate';
import { parseSettings, DEFAULT_SETTINGS, type Generator, type Rule } from '@/lib/settings';

/**
 * The rule editor's behaviour, without a page.
 *
 * Every question the editor actually has to get right — where a new rule lands,
 * what survives a change of type, what a move does at the end of the list — is a
 * question about a list of rules. Keeping those in pure functions is what makes
 * them assertable here rather than through a rendered DOM, where a failure would
 * name a selector instead of a rule.
 */

function ruleWith(overrides: Partial<Rule> = {}): Rule {
  return { ...newRule('r1'), match: { mode: 'contains', pattern: 'email' }, ...overrides };
}

describe('creating a rule (UC-009)', () => {
  it('starts invalid, so nothing is written before the user says what it is for', () => {
    // BR-009-1: the rule is created in the list but not yet storable. Creating
    // it pre-matching something would mean a rule that begins by doing whatever
    // the default pattern happened to hit.
    const created = newRule('id');
    expect(validateRule(created)).not.toEqual([]);
    expect(created.match.pattern).toBe('');
  });

  it('draws from the persona by default', () => {
    // DD-005: a rule written without thinking about the flag keeps the record
    // coherent. Breaking coherence is opt-in.
    expect(newRule('id').fromPersona).toBe(true);
  });

  it('appends rather than inserts, because order is precedence', () => {
    // BR-009-2. Inserting at the top would change the behaviour of every rule
    // already written, as a side effect of adding an unrelated one.
    const first = ruleWith({ id: 'first' });
    const list = addRule([first], 'second');

    expect(list.map((rule) => rule.id)).toEqual(['first', 'second']);
  });
});

describe('editing a rule (UC-010)', () => {
  it('replaces in place, keeping every position', () => {
    const rules = [ruleWith({ id: 'a' }), ruleWith({ id: 'b' }), ruleWith({ id: 'c' })];
    const edited = replaceRule(rules, { ...rules[1]!, label: 'changed' });

    expect(edited.map((rule) => rule.id)).toEqual(['a', 'b', 'c']);
    expect(edited[1]!.label).toBe('changed');
  });

  it('keeps identity, name, matcher and flag across a change of generator type', () => {
    // UC-009 A4. The identity especially: regenerating it on edit would turn
    // every edit into a delete and a create (BR-010-2).
    const before = ruleWith({
      id: 'keep-me',
      label: 'Postcode',
      sources: ['name'],
      fromPersona: false,
      generator: { type: 'date', format: 'YYYY', from: '2000-01-01', to: '2001-01-01' },
    });

    const after = changeGeneratorType(before, 'regex');

    expect(after.id).toBe('keep-me');
    expect(after.label).toBe('Postcode');
    expect(after.match).toEqual(before.match);
    expect(after.sources).toEqual(['name']);
    expect(after.fromPersona).toBe(false);
  });

  it('discards the previous type’s options, because they mean nothing to the new one', () => {
    // ND-9: carrying a date format into a regex is how the reference's single
    // overloaded `template` field became unreadable.
    const dated = ruleWith({
      generator: { type: 'date', format: 'DD/MM/YYYY', from: '2000-01-01', to: '2001-01-01' },
    });
    const asRegex = changeGeneratorType(dated, 'regex');

    expect(asRegex.generator).not.toHaveProperty('format');
    expect(asRegex.generator.type).toBe('regex');
  });

  it('changes nothing when the type is already the one asked for', () => {
    const rule = ruleWith({ generator: { type: 'constant', value: 'kept' } });
    expect(changeGeneratorType(rule, 'constant')).toBe(rule);
  });

  it.each<Generator['type']>([
    'name', 'email', 'username', 'organisation', 'telephone', 'url',
    'number', 'date', 'text', 'alphanumeric', 'regex', 'list', 'constant',
  ])('offers a valid default for %s, so switching type shows no error the user did not cause', (type) => {
    const rule = ruleWith({ generator: defaultGenerator(type) });
    // `constant` with an empty value is valid — an empty string is a legitimate
    // thing to write into a field.
    expect(validateRule(rule)).toEqual([]);
  });
});

describe('deleting and undoing (UC-011)', () => {
  it('removes only the named rule', () => {
    const rules = [ruleWith({ id: 'a' }), ruleWith({ id: 'b' }), ruleWith({ id: 'c' })];
    expect(removeRule(rules, 'b').map((rule) => rule.id)).toEqual(['a', 'c']);
  });

  it('restores to the position it held, not to the end', () => {
    // BR-011-2. Order is meaning, so a rule put back at the end is a different
    // configuration from the one that was deleted.
    const rules = [ruleWith({ id: 'a' }), ruleWith({ id: 'b' }), ruleWith({ id: 'c' })];
    const removed = rules[1]!;
    const after = removeRule(rules, 'b');

    expect(restoreRule(after, removed, 1).map((rule) => rule.id)).toEqual(['a', 'b', 'c']);
  });

  it('restores safely when the list changed underneath', () => {
    const removed = ruleWith({ id: 'gone' });
    expect(restoreRule([], removed, 5).map((rule) => rule.id)).toEqual(['gone']);
  });
});

describe('reordering (UC-012)', () => {
  const rules = [ruleWith({ id: 'a' }), ruleWith({ id: 'b' }), ruleWith({ id: 'c' })];

  it('moves one place at a time', () => {
    expect(moveRule(rules, 'c', -1).map((rule) => rule.id)).toEqual(['a', 'c', 'b']);
    expect(moveRule(rules, 'a', 1).map((rule) => rule.id)).toEqual(['b', 'a', 'c']);
  });

  it('does nothing at either end, rather than wrapping', () => {
    // A rule that jumped from first to last would rewrite the precedence of
    // every rule between them, from one keypress.
    expect(moveRule(rules, 'a', -1)).toBe(rules);
    expect(moveRule(rules, 'c', 1)).toBe(rules);
  });

  it('does nothing for a rule that is not there', () => {
    expect(moveRule(rules, 'missing', 1)).toBe(rules);
  });

  it('changes order and nothing else', () => {
    const moved = moveRule(rules, 'b', -1);
    expect(moved.map((rule) => rule.label)).toEqual(rules.map((rule) => rule.label));
    expect(new Set(moved.map((rule) => rule.id))).toEqual(new Set(rules.map((rule) => rule.id)));
  });
});

describe('the preview (UC-013)', () => {
  it('shows several samples, not one', () => {
    // BR-013-1: a single sample hides variability, and the case that matters is
    // the one that did not appear.
    const sample = sampleRule(ruleWith({ generator: { type: 'alphanumeric', template: '{digit:3}' } }), 'en-US', 1);

    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error('expected samples');
    expect(sample.values.length).toBeGreaterThan(1);
    for (const value of sample.values) expect(value).toMatch(/^\d{3}$/);
  });

  it('shows the problem and no samples when the rule is invalid', () => {
    // UC-013 A1: stale output that no longer belongs to what is on screen is
    // worse than none — a user who mistypes and sees the samples stay learns
    // that their change did nothing.
    const sample = sampleRule(ruleWith({ generator: { type: 'alphanumeric', template: '{nope}' } }), 'en-US', 1);

    expect(sample.ok).toBe(false);
    if (sample.ok) throw new Error('expected a rejection');
    expect(sample.problems.length).toBeGreaterThan(0);
  });

  it('draws a different person for each sample', () => {
    // BR-013-2: the coherence flag makes a rule agree with the rest of one
    // *form*, and a preview is not a form. Four copies of one email would
    // misrepresent what the flag does.
    const sample = sampleRule(ruleWith({ generator: { type: 'email' }, fromPersona: true }), 'en-US', 7);

    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error('expected samples');
    expect(new Set(sample.values).size).toBeGreaterThan(1);
  });

  it('previews each locale from its own corpus', () => {
    const rule = ruleWith({ generator: { type: 'telephone' }, fromPersona: true });
    const american = sampleRule(rule, 'en-US', 3);
    const swiss = sampleRule(rule, 'de-CH', 3);

    if (!american.ok || !swiss.ok) throw new Error('expected samples');
    for (const value of american.values) expect(value.startsWith('+1 ')).toBe(true);
    for (const value of swiss.values) expect(value.startsWith('+41 ')).toBe(true);
  });

  it('reports a rule that validates but cannot generate', () => {
    // UC-013 A2. Reachable by import rather than by authoring: FR-070 refuses
    // this at the point of writing, so a rule in this state arrived another way.
    const beyondSubset = ruleWith({ generator: { type: 'regex', pattern: 'a(?=b)' } });
    const sample = sampleRule(beyondSubset, 'en-US', 1);

    expect(sample.ok).toBe(false);
  });
});

describe('what the editor writes (UC-024)', () => {
  it('survives the round trip through the parser that will read it back', () => {
    // BR-024-7: the reader is the validator. A rule that survives the write but
    // not the read is how a user sees a rule saved and finds it altered on the
    // next fill, with nothing to indicate why.
    const rules = [
      ruleWith({ id: 'a', label: 'Email', generator: { type: 'email' } }),
      ruleWith({ id: 'b', label: 'Code', sources: ['name', 'id'], generator: { type: 'alphanumeric', template: 'X{digit:2}' } }),
      ruleWith({ id: 'c', enabled: false, fromPersona: false, match: { mode: 'regex', pattern: '^zip$' } }),
    ];

    const stored = parseSettings({ ...DEFAULT_SETTINGS, rules });

    expect(stored.rules).toEqual(rules);
  });

  it('keeps the order it was given', () => {
    const rules = ['c', 'a', 'b'].map((id) => ruleWith({ id, label: id }));
    expect(parseSettings({ ...DEFAULT_SETTINGS, rules }).rules.map((rule) => rule.id)).toEqual([
      'c', 'a', 'b',
    ]);
  });
});
