import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { generateBatch } from '@/lib/generators/batch';
import {
  agentSettings,
  DEFAULT_SETTINGS,
  DEFAULT_SOURCES,
  parseSettings,
  type Generator,
  type Rule,
  type Settings,
  type SourceToggles,
} from '@/lib/settings';
import { compileRules, effectiveSources, selectRule } from '@/lib/rules/match';
import { validateMatcher, validateRule, type RuleProblemCode } from '@/lib/rules/validate';
import { analysePattern } from '@/lib/rules/redos';
import { generateFromRegex, parseRegex } from '@/lib/rules/regex-subset';
import { generateFromTemplate, parseTemplate } from '@/lib/rules/template';
import { formatDate, isIsoDate, randomDate } from '@/lib/rules/dates';
import type { FieldDescriptor } from '@/lib/protocol';

/**
 * DD-005 — the settings schema and the rule model built on it.
 *
 * The engine's behaviour with no rules configured is covered by
 * `controls.test.ts`; what is asserted here is that rules change it in the ways
 * decided and in no others.
 */

function fragment(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function descriptorFor(html: string, ref = 0): FieldDescriptor {
  const element = collectCandidates(fragment(html))[0]!;
  const classification = classifyStructural(element, {
    skipHidden: false,
    skipPreFilled: false,
    writtenByUs: new WeakSet<Element>(),
  });
  if (!classification.fillable) throw new Error(`excluded: ${classification.reason}`);
  return describeField(element, ref, classification.kind);
}

const persona = createPersona(seededRandom(11));

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    label: 'test rule',
    enabled: true,
    match: { mode: 'contains', pattern: 'field' },
    generator: { type: 'constant', value: 'RULED' },
    fromPersona: true,
    ...overrides,
  };
}

/** One fill's worth of generation, with rules, through the real batch path. */
function fill(html: string, rules: readonly Rule[], toggles: SourceToggles = DEFAULT_SOURCES) {
  const descriptor = descriptorFor(html);
  return generateBatch([descriptor], {
    persona,
    randomFor: () => seededRandom(5),
    rules: compileRules(rules, toggles),
  });
}

function textOf(result: ReturnType<typeof fill>): string {
  const value = result.values[0]!;
  return value.as === 'text' ? value.value : `<${value.as}>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the settings schema (DD-005)', () => {
  it('falls back to defaults on anything unreadable', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ rules: 'not a list' }).rules).toEqual([]);
  });

  it('lifts the pre-DD-005 flat shape into its sections', () => {
    // The one structural change the tolerant parser is asked to survive. It is
    // asserted rather than assumed because DD-005 chose no migration ladder:
    // if this stops working, a user's settings silently revert to defaults.
    const settings = parseSettings({
      version: 1,
      dispatchEvents: false,
      skipHidden: false,
      skipPreFilled: true,
      ignorePatterns: ['^csrf', 'token$'],
    });

    expect(settings.behaviour.dispatchEvents).toBe(false);
    expect(settings.behaviour.skipPreFilled).toBe(true);
    // Lifted as `regex`, because that is what the old list held. Reading them as
    // `contains` would quietly change what a stored pattern means.
    expect(settings.exclusions.fields).toEqual([
      { mode: 'regex', pattern: '^csrf' },
      { mode: 'regex', pattern: 'token$' },
    ]);
  });

  it('drops a malformed rule rather than repairing it into something unasked for', () => {
    const settings = parseSettings({
      rules: [
        { id: 'ok', match: { mode: 'exact', pattern: 'email' }, generator: { type: 'email' } },
        { id: 'no-generator', match: { mode: 'exact', pattern: 'x' } },
        { id: 'unknown-generator', match: { mode: 'exact', pattern: 'y' }, generator: { type: 'wat' } },
        { id: 'no-match', generator: { type: 'email' } },
      ],
    });

    expect(settings.rules.map((entry) => entry.id)).toEqual(['ok']);
    // The flag defaults on, so a rule stored before it existed keeps coherence.
    expect(settings.rules[0]!.fromPersona).toBe(true);
  });

  it('sends the agent regex sources, never match modes', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      exclusions: {
        fields: [
          { mode: 'contains', pattern: 'a.b' },
          { mode: 'exact', pattern: 'csrf' },
          { mode: 'regex', pattern: '^tok' },
        ],
        domains: [],
      },
    };

    // `a.b` was a literal, so its dot must not survive as "any character".
    expect(agentSettings(settings).ignorePatterns).toEqual(['a\\.b', '^csrf$', '^tok']);
  });
});

describe('matching (FR-067, FR-068)', () => {
  const descriptor = descriptorFor('<input name="username" id="user_name" class="form-control">');

  it('anchors what the user anchored — the reference defect', () => {
    // `name` matching `username`, `firstname` and `company_name` is the exact
    // behaviour FR-068 exists to end.
    const anchored = compileRules([rule({ match: { mode: 'regex', pattern: '^name$' } })], DEFAULT_SOURCES);
    expect(selectRule(descriptor, anchored).selection).toBeUndefined();

    const loose = compileRules([rule({ match: { mode: 'contains', pattern: 'name' } })], DEFAULT_SOURCES);
    expect(loose.length).toBe(1);
    expect(selectRule(descriptor, loose).selection?.source).toBe('name');
  });

  it('treats a contains pattern as a literal', () => {
    const compiled = compileRules([rule({ match: { mode: 'contains', pattern: 'user.name' } })], DEFAULT_SOURCES);
    // Would match `user_name` if the dot were a wildcard, and must not.
    expect(selectRule(descriptor, compiled).selection).toBeUndefined();
  });

  it('matches exactly in exact mode', () => {
    const compiled = compileRules([rule({ match: { mode: 'exact', pattern: 'username' } })], DEFAULT_SOURCES);
    expect(selectRule(descriptor, compiled).selection?.source).toBe('name');
  });

  it('intersects a rule’s sources with the global toggles', () => {
    const classOnly = rule({ match: { mode: 'contains', pattern: 'form-control' }, sources: ['className'] });

    // `className` is off by default — the noisiest source (FR-027).
    expect(effectiveSources(classOnly, DEFAULT_SOURCES)).toEqual([]);
    expect(selectRule(descriptor, compileRules([classOnly], DEFAULT_SOURCES)).selection).toBeUndefined();

    const on = { ...DEFAULT_SOURCES, className: true };
    expect(effectiveSources(classOnly, on)).toEqual(['className']);
    expect(selectRule(descriptor, compileRules([classOnly], on)).selection?.source).toBe('className');
  });

  it('matches a component-rendered field on its test id alone (FR-083)', () => {
    // The case the source exists for: a framework-generated id, no `name`, no
    // placeholder, and the only identity anybody chose is the test attribute.
    const generated = descriptorFor('<input id=":r3:" data-testid="billing-postcode">');
    const compiled = compileRules(
      [rule({ match: { mode: 'contains', pattern: 'postcode' } })],
      DEFAULT_SOURCES,
    );
    const selection = selectRule(generated, compiled).selection;
    expect(selection?.source).toBe('testId');
    expect(selection?.text).toBe('billing-postcode');
  });

  it('bounds the test id by the global toggle like every other source', () => {
    const generated = descriptorFor('<input id=":r3:" data-qa="billing-postcode">');
    const scoped = rule({ match: { mode: 'contains', pattern: 'postcode' }, sources: ['testId'] });

    expect(selectRule(generated, compileRules([scoped], DEFAULT_SOURCES)).selection?.source) //
      .toBe('testId');

    const off = { ...DEFAULT_SOURCES, testId: false };
    expect(effectiveSources(scoped, off)).toEqual([]);
    expect(selectRule(generated, compileRules([scoped], off)).selection).toBeUndefined();
  });

  it('lets a global toggle silence a source no rule mentions', () => {
    const any = rule({ match: { mode: 'contains', pattern: 'user_name' } });
    const idOff = { ...DEFAULT_SOURCES, id: false };
    expect(selectRule(descriptor, compileRules([any], DEFAULT_SOURCES)).selection?.source).toBe('id');
    expect(selectRule(descriptor, compileRules([any], idOff)).selection).toBeUndefined();
  });

  it('takes the first matching rule and skips a disabled one (FR-031)', () => {
    const compiled = compileRules(
      [
        rule({ id: 'off', label: 'disabled', enabled: false, match: { mode: 'contains', pattern: 'user' } }),
        rule({ id: 'first', label: 'first', match: { mode: 'contains', pattern: 'user' } }),
        rule({ id: 'second', label: 'second', match: { mode: 'contains', pattern: 'user' } }),
      ],
      DEFAULT_SOURCES,
    );
    expect(selectRule(descriptor, compiled).selection?.rule.label).toBe('first');
  });

  it('reports a rule whose pattern will not compile instead of throwing', () => {
    const compiled = compileRules([rule({ match: { mode: 'regex', pattern: '([unclosed' } })], DEFAULT_SOURCES);
    const { selection, skipped } = selectRule(descriptor, compiled);

    expect(selection).toBeUndefined();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.problem).toBeDefined();
  });
});

describe('rule validation at save time (FR-070)', () => {
  it('rejects an empty or uncompilable pattern', () => {
    expect(validateMatcher({ mode: 'regex', pattern: '' })[0]?.code).toBe('ruleProblemPatternEmpty');

    const invalid = validateMatcher({ mode: 'regex', pattern: '([unclosed' })[0];
    expect(invalid?.code).toBe('ruleProblemPatternInvalid');
    // The engine's own complaint is carried as a substitution rather than
    // rewritten, so the user sees which construct it objected to.
    expect(invalid?.params?.[0]).toBeTruthy();
  });

  it('accepts a literal that would be invalid as a regex', () => {
    // The modes exist so a user can write `price (net)` without escaping it.
    expect(validateMatcher({ mode: 'contains', pattern: '([unclosed' })).toEqual([]);
  });

  it.each([
    ['(a+)+$', 'nested-quantifier'],
    ['(a*)*b', 'nested-quantifier'],
    ['(a?)*b', 'nullable-repetition'],
    ['(a|ab)*c', 'overlapping-alternation'],
    ['(x|x)+y', 'overlapping-alternation'],
  ])('rejects %s as catastrophic (NFR-009)', (pattern, shape) => {
    const problems = analysePattern(pattern);
    expect(problems.map((problem) => problem.shape)).toContain(shape);
    expect(validateMatcher({ mode: 'regex', pattern })).not.toEqual([]);
  });

  it.each([
    // Overlap found through a class and through a nested group — the two places
    // the first-character approximation has to look past a literal.
    ['([a-c]|[b-d])*x', 'overlapping-alternation'],
    ['((a)|a)+y', 'overlapping-alternation'],
    // Nullable through a counted quantifier starting at zero, not just through `?`.
    ['(a{0,3})*b', 'nullable-repetition'],
    // Unbounded through `{3,}` rather than `*` or `+`.
    ['(a{3,})+b', 'nested-quantifier'],
  ])('recognises %s through the shapes it has to look past', (pattern, shape) => {
    expect(analysePattern(pattern).map((problem) => problem.shape)).toContain(shape);
  });

  it('claims no overlap when it cannot tell', () => {
    // The analyser is tolerant by decision (DD-005): a construct it does not
    // model yields no finding rather than a guess. `.` could begin anything, and
    // reporting on it would reject patterns that are fine.
    expect(analysePattern('(.|a)*b')).toEqual([]);
  });

  it.each([
    '^email$',
    '^(first|last)_name$',
    '\\d{4}-\\d{2}',
    '^user[0-9]{1,4}$',
    '(?:street|address)_line[12]',
  ])('accepts the safe pattern %s', (pattern) => {
    expect(analysePattern(pattern)).toEqual([]);
    expect(validateMatcher({ mode: 'regex', pattern })).toEqual([]);
  });

  it.each<[Generator, string]>([
    [{ type: 'alphanumeric', template: 'INV-{digit:4}' }, ''],
    [{ type: 'regex', pattern: '[A-Z]{3}' }, ''],
    [{ type: 'list', items: ['a'] }, ''],
    [{ type: 'number', min: 1, max: 10, decimals: 0 }, ''],
    [{ type: 'date', format: 'YYYY-MM-DD', from: '2000-01-01', to: '2020-01-01' }, ''],
  ])('accepts a well-formed %o', (generator) => {
    expect(validateRule(rule({ generator }))).toEqual([]);
  });

  /**
   * Each case names the code, and where a parser below supplies detail, the
   * substring of that detail which identifies the construct.
   *
   * The code is what the surface resolves against the catalog; the detail is the
   * part deliberately left in English, because it names syntax rather than
   * addressing the user. Asserting both keeps the split honest — a code with the
   * detail dropped would still pass a code-only assertion while showing the user
   * a sentence with an empty parenthesis in it.
   */
  it.each<[Generator, RuleProblemCode, string | undefined]>([
    [{ type: 'alphanumeric', template: 'x-{digits:4}' }, 'ruleProblemTemplateInvalid', 'is not a placeholder'],
    [{ type: 'alphanumeric', template: 'x-{digit' }, 'ruleProblemTemplateInvalid', 'never closed'],
    [{ type: 'alphanumeric', template: '{digit:0}' }, 'ruleProblemTemplateInvalid', 'must repeat between'],
    [{ type: 'regex', pattern: 'a(?=b)c' }, 'ruleProblemRegexUngeneratable', 'lookahead is not supported'],
    [{ type: 'regex', pattern: '(a)\\1' }, 'ruleProblemRegexUngeneratable', 'backreferences are not supported'],
    [{ type: 'regex', pattern: '(?<year>\\d{4})' }, 'ruleProblemRegexUngeneratable', 'named groups are not supported'],
    [{ type: 'number', min: 10, max: 1, decimals: 0 }, 'ruleProblemNumberRange', undefined],
    [{ type: 'text', minWords: 9, maxWords: 2 }, 'ruleProblemTextRange', undefined],
    [{ type: 'date', format: 'no tokens here', from: '2000-01-01', to: '2001-01-01' }, 'ruleProblemDateNoToken', undefined],
    [{ type: 'date', format: 'YYYY', from: '2000-02-31', to: '2001-01-01' }, 'ruleProblemDateBounds', undefined],
    [{ type: 'date', format: 'YYYY', from: '2005-01-01', to: '2001-01-01' }, 'ruleProblemDateRange', undefined],
  ])('rejects %o with a code naming the problem', (generator, code, detail) => {
    const problems = validateRule(rule({ generator }));
    const problem = problems.find((candidate) => candidate.code === code);

    expect(problem, `expected ${code}, got ${problems.map((p) => p.code).join(', ')}`).toBeDefined();
    if (detail === undefined) {
      expect(problem?.params).toBeUndefined();
    } else {
      expect(problem?.params?.[0]).toContain(detail);
    }
  });

  /**
   * FR-067. A rule that names its own sources and then names none of them is
   * inert: `effectiveSources` returns nothing to iterate, so it can never match.
   * Unticking the last of the six is one click in the editor, and nothing else
   * would have said so — the preview draws from the generator, which is fine.
   */
  it('rejects a rule scoped to no source at all', () => {
    expect(validateRule(rule({ sources: [] }))[0]?.code).toBe('ruleProblemNoSources');
  });

  it('accepts a rule scoped to one source, and one that names none', () => {
    expect(validateRule(rule({ sources: ['name'] }))).toEqual([]);
    // `undefined` is not "no sources", it is "whatever is enabled globally".
    expect(validateRule(rule({}))).toEqual([]);
  });
});

describe('the generators (FR-019..FR-022)', () => {
  it('expands a template and keeps its literals', () => {
    const parsed = parseTemplate('INV-{digit:4}-{upper:2}');
    if (!parsed.ok) throw new Error(parsed.problem);

    const value = generateFromTemplate(parsed.parts, seededRandom(3));
    expect(value).toMatch(/^INV-\d{4}-[A-Z]{2}$/);
  });

  it('treats doubled braces as literal braces', () => {
    const parsed = parseTemplate('{{{digit}}}');
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(generateFromTemplate(parsed.parts, seededRandom(1))).toMatch(/^\{\d\}$/);
  });

  it.each([
    '[A-Z]{3}-\\d{4}',
    '(cat|dog)-\\d+',
    '^[a-z]{2,4}@example\\.(com|org)$',
    '\\w{5}',
    'a?b+c*',
  ])('generates a value that matches its own pattern: %s', (pattern) => {
    const parsed = parseRegex(pattern);
    if (!parsed.ok) throw new Error(parsed.problem);

    for (let seed = 0; seed < 25; seed++) {
      const value = generateFromRegex(parsed.node, seededRandom(seed));
      expect(new RegExp(`^(?:${pattern.replace(/^\^|\$$/g, '')})$`).test(value)).toBe(true);
    }
  });

  it('bounds an unbounded quantifier rather than running away', () => {
    const parsed = parseRegex('a*');
    if (!parsed.ok) throw new Error(parsed.problem);
    for (let seed = 0; seed < 30; seed++) {
      // The cap is measured against the fixtures: the longest declared
      // maxlength is 12 and the largest pattern lower bound is {8,}.
      expect(generateFromRegex(parsed.node, seededRandom(seed)).length).toBeLessThanOrEqual(8);
    }
  });

  it('honours character classes, negation and ranges', () => {
    for (const [pattern, allowed] of [
      ['[a-c]{5}', /^[a-c]{5}$/],
      ['[^0-9]{4}', /^[^0-9]{4}$/],
      ['[\\d]{3}', /^\d{3}$/],
      ['\\W{2}', /^\W{2}$/],
      ['\\s\\S', /^\s\S$/],
    ] as const) {
      const parsed = parseRegex(pattern);
      if (!parsed.ok) throw new Error(parsed.problem);
      for (let seed = 0; seed < 15; seed++) {
        expect(generateFromRegex(parsed.node, seededRandom(seed))).toMatch(allowed);
      }
    }
  });

  it('drops the constructs that describe a position rather than a character', () => {
    for (const [pattern, expected] of [
      ['^abc$', 'abc'],
      ['a\\bb', 'ab'],
      ['a\\tb', 'a\tb'],
    ] as const) {
      const parsed = parseRegex(pattern);
      if (!parsed.ok) throw new Error(parsed.problem);
      expect(generateFromRegex(parsed.node, seededRandom(1))).toBe(expected);
    }
  });

  it('accepts a lazy quantifier and generates the same language', () => {
    // Laziness decides which match a matcher prefers, not which strings are in
    // the language — so rejecting it would refuse a pattern that is fine.
    const parsed = parseRegex('a+?b');
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(generateFromRegex(parsed.node, seededRandom(2))).toMatch(/^a+b$/);
  });

  it('honours a counted quantifier exactly', () => {
    const parsed = parseRegex('x{2,3}y{4}');
    if (!parsed.ok) throw new Error(parsed.problem);
    for (let seed = 0; seed < 20; seed++) {
      expect(generateFromRegex(parsed.node, seededRandom(seed))).toMatch(/^x{2,3}y{4}$/);
    }
  });

  it.each([
    ['[a-z', 'never closed'],
    ['[]', 'matches nothing'],
    ['[z-a]', 'runs backwards'],
    ['abc\\', 'trailing'],
    ['(?<=a)b', 'lookbehind is not supported'],
    ['(?i)x', 'is not supported'],
    ['(ab', 'never closed'],
    ['ab)c', 'unbalanced'],
  ])('refuses %s with a message naming the construct', (pattern, expected) => {
    const parsed = parseRegex(pattern);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.problem).toContain(expected);
  });

  it('formats a date with our own tokens, in UTC', () => {
    const date = new Date(Date.UTC(2019, 6, 4, 9, 5, 3));
    expect(formatDate(date, 'YYYY-MM-DD')).toBe('2019-07-04');
    expect(formatDate(date, 'DD/MM/YY HH:mm:ss')).toBe('04/07/19 09:05:03');
    // A single letter is a literal, so an ISO `T` needs no escaping.
    expect(formatDate(date, 'YYYY-MM-DDTHH:mm')).toBe('2019-07-04T09:05');
    expect(formatDate(date, 'DD MMM YYYY')).toBe('04 Jul 2019');
  });

  it('draws a date inside its range', () => {
    for (let seed = 0; seed < 20; seed++) {
      const date = randomDate('2020-01-01', '2020-12-31', seededRandom(seed));
      expect(formatDate(date, 'YYYY')).toBe('2020');
    }
  });

  it('rejects a day that does not exist', () => {
    expect(isIsoDate('2026-02-31')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('not a date')).toBe(false);
  });
});

describe('rules through a fill', () => {
  it('takes precedence over the built-in generator', () => {
    const result = fill('<input name="nickname">', [
      rule({ match: { mode: 'contains', pattern: 'nick' }, generator: { type: 'constant', value: 'Zed' } }),
    ]);
    expect(textOf(result)).toBe('Zed');
    expect(result.values[0]!.provenance).toContain('rule "test rule"');
  });

  it('leaves an unmatched field to the persona generator', () => {
    const result = fill('<input name="email" type="email">', [
      rule({ match: { mode: 'exact', pattern: 'nothing' } }),
    ]);
    expect(textOf(result)).toBe(persona.email);
  });

  it('keeps the record coherent by default (ND-1)', () => {
    // Deliberately a field the built-in generator would *not* fill with an
    // email — it resolves to neutral text — so this asserts the rule ran and
    // drew from the persona, rather than passing on the default's behaviour.
    const html = '<input name="account_ref">';
    const emailRule = rule({ match: { mode: 'contains', pattern: 'account' }, generator: { type: 'email' } });

    expect(textOf(fill(html, []))).not.toContain('@');
    // The whole point of the flag defaulting on: a rule that writes an email
    // still writes *this fill's* email, so the page's own confirmation field
    // and summary continue to agree.
    expect(textOf(fill(html, [emailRule]))).toBe(persona.email);
  });

  it('generates freshly when the flag is off, and still deterministically', () => {
    const off = rule({
      match: { mode: 'contains', pattern: 'account' },
      generator: { type: 'email' },
      fromPersona: false,
    });
    const first = fill('<input name="account_ref">', [off]);
    const second = fill('<input name="account_ref">', [off]);

    expect(textOf(first)).not.toBe(persona.email);
    expect(textOf(first)).toContain('@');
    // Same control, same seed, same value (FR-080).
    expect(textOf(second)).toBe(textOf(first));
  });

  it('loses to confirmation mirroring, and says so (FR-024)', () => {
    const confirming = fill('<input name="confirm_email" type="email">', [
      rule({ match: { mode: 'contains', pattern: 'email' }, generator: { type: 'constant', value: 'OTHER' } }),
    ]);

    expect(textOf(confirming)).toBe(persona.email);
    expect(confirming.values[0]!.provenance).toContain('overridden');
  });

  it('applies to a field that only looks like a confirmation', () => {
    // `repeat_order_reference` matches the marker but resolves to no persona
    // slot, so there is nothing for it to mirror and the rule governs it.
    const result = fill('<input name="repeat_order_reference">', [
      rule({ match: { mode: 'contains', pattern: 'order' }, generator: { type: 'constant', value: 'ORD-1' } }),
    ]);
    expect(textOf(result)).toBe('ORD-1');
  });

  it('selects the option a rule names, by label or by value', () => {
    const html = '<select name="country"><option value="">Pick</option><option value="DE">Germany</option><option value="FR">France</option></select>';

    const byLabel = fill(html, [
      rule({ match: { mode: 'contains', pattern: 'country' }, generator: { type: 'constant', value: 'Germany' } }),
    ]);
    expect(byLabel.values[0]).toMatchObject({ as: 'choice', values: ['DE'] });

    const byValue = fill(html, [
      rule({ match: { mode: 'contains', pattern: 'country' }, generator: { type: 'constant', value: 'fr' } }),
    ]);
    expect(byValue.values[0]).toMatchObject({ as: 'choice', values: ['FR'] });
  });

  it('falls back to the picker when the named option is not offered', () => {
    const result = fill(
      '<select name="country"><option value="DE">Germany</option></select>',
      [rule({ match: { mode: 'contains', pattern: 'country' }, generator: { type: 'constant', value: 'Atlantis' } })],
    );
    // The rule was about *which* option; naming one that does not exist leaves
    // nothing to honour, and a field filled by the picker beats an empty one.
    expect(result.values[0]).toMatchObject({ as: 'choice', values: ['DE'] });
  });

  it('leaves a checkbox to the built-in behaviour', () => {
    const result = fill('<input type="checkbox" name="terms_accept" required>', [
      rule({ match: { mode: 'contains', pattern: 'terms' }, generator: { type: 'constant', value: 'yes' } }),
    ]);
    expect(result.values[0]).toMatchObject({ as: 'toggle', checked: true });
  });

  it('fits a rule’s output to the field, not the other way round (FR-072)', () => {
    const result = fill('<input name="code" maxlength="5">', [
      rule({ match: { mode: 'contains', pattern: 'code' }, generator: { type: 'constant', value: 'ABCDEFGHIJ' } }),
    ]);
    expect(textOf(result)).toBe('ABCDE');
  });

  it('names a rule it could not run, and fills the field anyway', () => {
    // Reachable without ever passing FR-070's authoring check: imported, or
    // synced from a device running a newer version.
    const result = fill('<input name="ref">', [
      rule({ match: { mode: 'regex', pattern: '([unclosed' } }),
      rule({ id: 'bad-template', label: 'bad template', match: { mode: 'contains', pattern: 'ref' }, generator: { type: 'alphanumeric', template: '{nope}' } }),
    ]);

    expect(result.skippedRules.join(' ')).toContain('bad template');
    // Still filled, by the generator behind the rule.
    expect(textOf(result)).not.toBe('');
  });

  it('draws list items per field rather than sharing one draw', () => {
    const items = ['alpha', 'beta', 'gamma', 'delta'];
    const listRule = rule({ match: { mode: 'contains', pattern: 'tag' }, generator: { type: 'list', items } });

    const descriptors = [
      descriptorFor('<input name="tag_one">', 0),
      descriptorFor('<input name="tag_two">', 1),
    ];
    const result = generateBatch(descriptors, {
      persona,
      // Different streams per control, as the real background does per token.
      randomFor: () => seededRandom(descriptors.length),
      rules: compileRules([listRule], DEFAULT_SOURCES),
    });

    for (const value of result.values) {
      expect(items).toContain(value.as === 'text' ? value.value : '');
    }
  });

  it.each<[Generator, RegExp]>([
    [{ type: 'number', min: 5, max: 9, decimals: 2 }, /^[5-9]\.\d{2}$/],
    [{ type: 'date', format: 'DD/MM/YYYY', from: '2001-01-01', to: '2001-12-31' }, /^\d{2}\/\d{2}\/2001$/],
    [{ type: 'text', minWords: 3, maxWords: 3 }, /^\S+ \S+ \S+$/],
    [{ type: 'alphanumeric', template: 'AC-{consonant}{vowel}{digit:2}' }, /^AC-[bcdfghjklmnpqrstvwxyz][aeiou]\d{2}$/],
    [{ type: 'regex', pattern: '[A-Z]{2}\\d{3}' }, /^[A-Z]{2}\d{3}$/],
    [{ type: 'constant', value: 'fixed' }, /^fixed$/],
  ])('drives %o through a real fill', (generator, shape) => {
    const result = fill('<input name="widget">', [
      rule({ match: { mode: 'contains', pattern: 'widget' }, generator }),
    ]);
    expect(textOf(result)).toMatch(shape);
  });

  it('names each of the persona-backed types', () => {
    const cases: ReadonlyArray<[Generator, string]> = [
      [{ type: 'name', part: 'full' }, persona.fullName],
      [{ type: 'name', part: 'first' }, persona.firstName],
      [{ type: 'name', part: 'last' }, persona.lastName],
      [{ type: 'username' }, persona.username],
      [{ type: 'organisation' }, persona.organisation],
      [{ type: 'telephone' }, persona.phone],
      [{ type: 'url' }, persona.url],
    ];
    for (const [generator, expected] of cases) {
      const result = fill('<input name="widget">', [
        rule({ match: { mode: 'contains', pattern: 'widget' }, generator }),
      ]);
      expect(textOf(result)).toBe(expected);
    }
  });

  it('selects into a multi-select', () => {
    const result = fill(
      '<select name="langs" multiple><option value="en">English</option><option value="de">German</option></select>',
      [rule({ match: { mode: 'contains', pattern: 'langs' }, generator: { type: 'constant', value: 'German' } })],
    );
    expect(result.values[0]).toMatchObject({ as: 'choice', values: ['de'] });
  });

  it('never picks a disabled option, even when a rule names it', () => {
    const result = fill(
      '<select name="tier"><option value="free">Free</option><option value="pro" disabled>Pro</option></select>',
      [rule({ match: { mode: 'contains', pattern: 'tier' }, generator: { type: 'constant', value: 'Pro' } })],
    );
    // Falls through to the picker, which excludes disabled options (D3).
    expect(result.values[0]).toMatchObject({ as: 'choice', values: ['free'] });
  });

  it('falls back rather than indexing an empty list when a rule names no offered value (D6)', () => {
    // The reference's `selectRandomRadio` filters the group's values down to the
    // ones the rule allows and then indexes the result at random — so a rule
    // whose values match none of the group throws a `TypeError` and abandons the
    // rest of the page. Here the rule simply does not apply, and the built-in
    // picker answers the group.
    document.body.innerHTML = '';
    const host = fragment(
      `<label>Yes <input type="radio" name="contact" value="yes"></label>
       <label>No <input type="radio" name="contact" value="no"></label>`,
    );
    const first = collectCandidates(host)[0]!;
    const descriptor = describeField(first, 0, 'radio', { group: 'g0' });

    const result = generateBatch([descriptor], {
      persona,
      randomFor: () => seededRandom(5),
      rules: compileRules(
        [
          rule({
            match: { mode: 'contains', pattern: 'contact' },
            // Neither item exists in the group.
            generator: { type: 'list', items: ['telephone', 'carrier pigeon'] },
          }),
        ],
        DEFAULT_SOURCES,
      ),
    });

    const value = result.values[0]!;
    expect(value.as).toBe('choice');
    if (value.as !== 'choice') throw new Error('a radio group is answered by choice');
    expect(['yes', 'no']).toContain(value.values[0]);
  });

  it('behaves exactly as before when no rule is configured', () => {
    const withNone = fill('<input name="given_name">', []);
    expect(textOf(withNone)).toBe(persona.firstName);
    expect(withNone.skippedRules).toEqual([]);
  });
});
