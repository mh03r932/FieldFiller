import { describe, expect, it } from 'vitest';
import {
  agentSettings,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_SETTINGS,
  DEFAULT_SOURCES,
  escapeRegex,
  parseSettings,
  patternSource,
  type Settings,
} from '@/lib/settings';

/**
 * DD-005's schema, and the tolerant parser every load goes through.
 *
 * Added 2026-08-15, when `scripts/check-coverage-scope.mjs` found this file
 * measured by coverage and matched by no threshold glob — at 62% lines, a day
 * after it was written. It is the clearest case for the gate: `parseSettings`
 * fails by *dropping* things, so an untested branch here does not throw, log or
 * fail a build. It quietly returns a user's settings with their work missing.
 *
 * FR-073 already records that a future structural change discards what the
 * parser cannot recognise. That is an accepted risk about changes not yet made;
 * it is not a licence for the coercions written today to be wrong.
 */
describe('parseSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const stored of [undefined, null, 'settings', 42, true]) {
      expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('returns the defaults for an empty object, first-run', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('pins the version rather than reading it', () => {
    // ND-13: there is no way to load a state unmigrated, because the parser does
    // not have a "leave it as it was" branch to reach.
    expect(parseSettings({ version: 99 }).version).toBe(1);
    expect(parseSettings({ version: 'one' }).version).toBe(1);
  });

  describe('the pre-DD-005 flat shape', () => {
    it('lifts the three behaviour flags out of the top level', () => {
      const parsed = parseSettings({
        dispatchEvents: false,
        skipHidden: false,
        skipPreFilled: true,
      });
      expect(parsed.behaviour).toMatchObject({
        dispatchEvents: false,
        skipHidden: false,
        skipPreFilled: true,
      });
    });

    it('prefers the nested value when a state holds both', () => {
      const parsed = parseSettings({ dispatchEvents: false, behaviour: { dispatchEvents: true } });
      expect(parsed.behaviour.dispatchEvents).toBe(true);
    });

    it('lifts ignorePatterns as regex matchers, never as contains', () => {
      // The one migration that would change what a stored pattern *means*.
      // `ignorePatterns` entries were regex sources; reading `^card$` as a
      // `contains` pattern would silently stop it matching anything.
      const parsed = parseSettings({ ignorePatterns: ['^card$', 'search'] });
      expect(parsed.exclusions.fields).toEqual([
        { mode: 'regex', pattern: '^card$' },
        { mode: 'regex', pattern: 'search' },
      ]);
    });

    it('prefers the nested exclusions when a state holds both', () => {
      const parsed = parseSettings({
        ignorePatterns: ['old'],
        exclusions: { fields: [{ mode: 'contains', pattern: 'new' }] },
      });
      expect(parsed.exclusions.fields).toEqual([{ mode: 'contains', pattern: 'new' }]);
    });
  });

  describe('rules', () => {
    const rule = {
      id: 'r1',
      label: 'Email',
      match: { mode: 'contains', pattern: 'email' },
      generator: { type: 'email' },
    };

    it('reads a well-formed rule and defaults what it omits', () => {
      const [parsed] = parseSettings({ rules: [rule] }).rules;
      expect(parsed).toEqual({
        id: 'r1',
        label: 'Email',
        enabled: true,
        match: { mode: 'contains', pattern: 'email' },
        generator: { type: 'email' },
        // ND-1's coherent record is the default, so a rule stored before the
        // flag existed keeps drawing from the persona rather than quietly
        // producing an unrelated value.
        fromPersona: true,
      });
    });

    it('falls back to the pattern for a missing label, and to the pattern and position for an id', () => {
      const [parsed] = parseSettings({
        rules: [{ match: rule.match, generator: rule.generator }],
      }).rules;
      expect(parsed).toMatchObject({ id: 'email#0', label: 'email' });
    });

    it('gives two rules with one pattern two identities (BR-010-2)', () => {
      // The pattern alone was the fallback until 2026-08-24, and every editor
      // write is keyed on the id: `replaceRule` maps *all* matches and
      // `removeRule` filters all, so a hand-written file with two `email` rules
      // gave the user a list where editing one relabelled both and deleting one
      // deleted both. Fills never saw it — matching takes the first hit — which
      // is exactly why nothing else catches this.
      const { rules } = parseSettings({
        rules: [
          { label: 'first', match: rule.match, generator: rule.generator },
          { label: 'second', match: rule.match, generator: rule.generator },
        ],
      });

      expect(rules.map((parsed) => parsed.id)).toEqual(['email#0', 'email#1']);
    });

    it('leaves a stated id alone, wherever it sits', () => {
      // The fallback is for a file that states none. A file that states one is
      // making a claim about identity that a parser has no business rewriting —
      // including the claim, in the second entry here, that it is the same rule
      // as the first.
      const { rules } = parseSettings({
        rules: [
          { id: 'chosen', match: rule.match, generator: rule.generator },
          { id: 'chosen', match: rule.match, generator: rule.generator },
        ],
      });

      expect(rules.map((parsed) => parsed.id)).toEqual(['chosen', 'chosen']);
    });

    it('numbers by position in the file, so a dropped entry does not renumber the rest', () => {
      // The alternative is an id that depends on what was *dropped* beside it:
      // add a malformed rule at the top of a file and every id below it shifts.
      const { rules } = parseSettings({
        rules: [{ label: 'unreadable' }, { match: rule.match, generator: rule.generator }],
      });

      expect(rules.map((parsed) => parsed.id)).toEqual(['email#1']);
    });

    it('drops a malformed rule instead of repairing it', () => {
      // A rule silently repaired into something the user did not write is worse
      // than one visibly missing — there is no sensible default for "what should
      // this have generated".
      const parsed = parseSettings({
        rules: [
          rule,
          null,
          'a rule',
          { match: rule.match },
          { generator: rule.generator },
          { match: { mode: 'sideways', pattern: 'x' }, generator: rule.generator },
          { match: { mode: 'contains', pattern: '' }, generator: rule.generator },
          { match: rule.match, generator: { type: 'astrology' } },
        ],
      });
      expect(parsed.rules).toHaveLength(1);
      expect(parsed.rules[0]?.id).toBe('r1');
    });

    it('reads a rule source list, and keeps an empty one empty', () => {
      expect(parseSettings({ rules: [{ ...rule, sources: ['label', 'id'] }] }).rules[0]?.sources) //
        .toEqual(['label', 'id']);
      expect(parseSettings({ rules: [{ ...rule, sources: ['label', 'aura'] }] }).rules[0]?.sources) //
        .toEqual(['label']);
      // Naming only sources we do not have is not the same as naming none: the
      // rule matches nothing, visibly, rather than widening to every source.
      expect(parseSettings({ rules: [{ ...rule, sources: ['aura'] }] }).rules[0]?.sources).toEqual(
        [],
      );
      // Absent means "no opinion", which is the one case that collapses away.
      expect(parseSettings({ rules: [rule] }).rules[0]?.sources).toBeUndefined();
      expect(parseSettings({ rules: [{ ...rule, sources: 'label' }] }).rules[0]?.sources) //
        .toBeUndefined();
    });

    it('reads no rules from a non-array', () => {
      expect(parseSettings({ rules: { r1: rule } }).rules).toEqual([]);
    });
  });

  describe('generators', () => {
    const wrap = (generator: unknown): unknown =>
      parseSettings({ rules: [{ match: { mode: 'contains', pattern: 'x' }, generator }] })
        .rules[0]?.generator;

    it('reads the option-free types', () => {
      for (const type of ['email', 'username', 'organisation', 'telephone', 'url']) {
        expect(wrap({ type })).toEqual({ type });
      }
    });

    it('reads a name part and defaults an unknown one to full', () => {
      expect(wrap({ type: 'name', part: 'first' })).toEqual({ type: 'name', part: 'first' });
      expect(wrap({ type: 'name', part: 'middle' })).toEqual({ type: 'name', part: 'full' });
      expect(wrap({ type: 'name' })).toEqual({ type: 'name', part: 'full' });
    });

    it('orders a reversed number range rather than rejecting it', () => {
      expect(wrap({ type: 'number', min: 90, max: 10 })).toEqual({
        type: 'number',
        min: 10,
        max: 90,
        decimals: 0,
      });
      expect(wrap({ type: 'number' })).toEqual({ type: 'number', min: 0, max: 100, decimals: 0 });
      expect(wrap({ type: 'number', decimals: 40 })).toMatchObject({ decimals: 10 });
      expect(wrap({ type: 'number', min: 'ten' })).toMatchObject({ min: 0 });
    });

    it('orders a reversed word range too', () => {
      expect(wrap({ type: 'text', minWords: 30, maxWords: 4 })).toEqual({
        type: 'text',
        minWords: 4,
        maxWords: 30,
      });
      expect(wrap({ type: 'text' })).toEqual({ type: 'text', minWords: 5, maxWords: 20 });
    });

    it('defaults a date format and range', () => {
      expect(wrap({ type: 'date' })).toEqual({
        type: 'date',
        format: 'YYYY-MM-DD',
        from: '1970-01-01',
        to: '2035-12-31',
      });
      expect(wrap({ type: 'date', format: '' })).toMatchObject({ format: 'YYYY-MM-DD' });
      expect(wrap({ type: 'date', format: 'DD.MM.YYYY', from: '2000-01-01' })).toMatchObject({
        format: 'DD.MM.YYYY',
        from: '2000-01-01',
      });
    });

    it('rejects the types whose whole content is the missing option', () => {
      // ND-9's argument: a `regex` generator with no pattern is not a slightly
      // wrong regex generator, it is not one at all — so the rule goes, rather
      // than the rule staying and generating something arbitrary.
      for (const generator of [
        { type: 'alphanumeric' },
        { type: 'alphanumeric', template: '' },
        { type: 'regex' },
        { type: 'regex', pattern: '' },
        { type: 'list' },
        { type: 'list', items: [] },
        { type: 'list', items: [1, 2] },
        { type: 'constant' },
        { type: 'constant', value: 7 },
      ]) {
        expect(wrap(generator)).toBeUndefined();
      }
      expect(wrap({ type: 'constant', value: '' })).toEqual({ type: 'constant', value: '' });
      expect(wrap({ type: 'list', items: ['a', 2, 'b'] })).toEqual({
        type: 'list',
        items: ['a', 'b'],
      });
    });

    it('rejects a generator that is not an object', () => {
      expect(wrap(null)).toBeUndefined();
      expect(wrap('email')).toBeUndefined();
    });
  });

  describe('the rest of the state', () => {
    it('clamps the password length and coerces the flags', () => {
      expect(parseSettings({ passwords: { length: 4000 } }).passwords.length).toBe(256);
      expect(parseSettings({ passwords: { length: 0 } }).passwords.length).toBe(1);
      expect(parseSettings({ passwords: { length: 12.7 } }).passwords.length).toBe(12);
      expect(parseSettings({ passwords: { length: Number.NaN } }).passwords.length).toBe(
        DEFAULT_PASSWORD_POLICY.length,
      );
      expect(parseSettings({ passwords: { symbols: 'yes' } }).passwords.symbols).toBe(
        DEFAULT_PASSWORD_POLICY.symbols,
      );
      expect(parseSettings({ passwords: 'strong' }).passwords).toEqual(DEFAULT_PASSWORD_POLICY);
    });

    it('reads every match source toggle and defaults the ones it cannot', () => {
      expect(parseSettings({ sources: { className: true, label: false } }).sources).toEqual({
        ...DEFAULT_SOURCES,
        className: true,
        label: false,
      });
      expect(parseSettings({ sources: { label: 'sometimes' } }).sources).toEqual(DEFAULT_SOURCES);
      expect(parseSettings({}).sources).toEqual(DEFAULT_SOURCES);
    });

    it('ships the noisy source off and the deliberate one on (BR-018-2, BR-018-5)', () => {
      expect(DEFAULT_SOURCES.className).toBe(false);
      expect(DEFAULT_SOURCES.testId).toBe(true);
    });

    it('defaults a source a file predates rather than reading its absence as off', () => {
      // A configuration exported before `testId` existed names six sources. Off
      // is a choice the user never made, and it would silently cost them the
      // best identity on a component-rendered form — so the parser's default
      // stands, exactly as it does for a file with no `sources` key at all.
      const before = { name: true, id: true, className: false, label: true, placeholder: true, ariaLabel: true };
      expect(parseSettings({ sources: before }).sources.testId).toBe(true);
    });

    it('keeps only positive integer max-lengths', () => {
      expect(parseSettings({ behaviour: { maxLengths: { text: 20, email: 0, url: 2.5 } } }) //
        .behaviour.maxLengths).toEqual({ text: 20 });
      expect(parseSettings({ behaviour: { maxLengths: null } }).behaviour.maxLengths).toEqual({});
    });

    it('keeps only string domains', () => {
      expect(
        parseSettings({ exclusions: { domains: ['bank.test', 42, null, '*.gov'] } }).exclusions
          .domains,
      ).toEqual(['bank.test', '*.gov']);
      expect(parseSettings({ exclusions: { domains: 'bank.test' } }).exclusions.domains).toEqual([]);
    });

    /**
     * A blank glob is an absent entry, the way a blank field pattern already was.
     *
     * Not tidiness. `exclusionFor` skips the check entirely for an empty list —
     * which is what keeps a tab whose address cannot be read fillable on a fresh
     * install — so one abandoned "Add a site" row made the list non-empty and
     * refused every unreadable tab from then on, with an empty-looking row as the
     * only explanation on offer.
     */
    it('drops blank domain patterns, as it already dropped blank field patterns', () => {
      expect(
        parseSettings({ exclusions: { domains: ['', 'bank.test', ''] } }).exclusions.domains,
      ).toEqual(['bank.test']);
      expect(parseSettings({ exclusions: { domains: [''] } }).exclusions.domains).toEqual([]);
    });

    it('drops blank profile addresses too, and keeps invalid ones', () => {
      const [profile] = parseSettings({
        profiles: [{ id: 'p1', urls: ['', 'a b.test', '*.staging.test/*'], rules: [] }],
      }).profiles;
      // The bad pattern stays: it is an entry with a problem, which the editor
      // flags, and discarding it would lose a pattern half-way through being
      // typed. Only the blank — an entry that is not there — goes.
      expect(profile?.urls).toEqual(['a b.test', '*.staging.test/*']);
    });

    it('reads profiles and drops the ones with no id', () => {
      const parsed = parseSettings({
        profiles: [
          { id: 'p1', urls: ['https://a.test/*'], rules: [] },
          { id: 'p2', label: 'Staging', enabled: false, urls: [], rules: [] },
          { label: 'nameless' },
          null,
          'p3',
        ],
      });
      expect(parsed.profiles).toHaveLength(2);
      expect(parsed.profiles[0]).toEqual({
        id: 'p1',
        label: 'p1',
        enabled: true,
        urls: ['https://a.test/*'],
        rules: [],
      });
      expect(parsed.profiles[1]?.label).toBe('Staging');
      expect(parsed.profiles[1]?.enabled).toBe(false);
      expect(parseSettings({ profiles: {} }).profiles).toEqual([]);
    });

    it('drops a matcher it cannot read, from either shape', () => {
      expect(
        parseSettings({
          exclusions: {
            fields: [
              { mode: 'exact', pattern: 'csrf' },
              { mode: 'exact' },
              { mode: 'nearby', pattern: 'x' },
              { pattern: 'x' },
              { mode: 'contains', pattern: '' },
              null,
              42,
              'legacy-source',
            ],
          },
        }).exclusions.fields,
      ).toEqual([
        { mode: 'exact', pattern: 'csrf' },
        { mode: 'regex', pattern: 'legacy-source' },
      ]);
      expect(parseSettings({ exclusions: { fields: 'csrf' } }).exclusions.fields).toEqual([]);
    });
  });

  it('is idempotent — parsing its own output changes nothing', () => {
    // BR-024-7: a write is validated by the same reader that will load it. If
    // that reader were not a fixpoint, a state could change every time it was
    // saved and reloaded, which is the kind of drift nobody goes looking for.
    const messy = {
      dispatchEvents: false,
      ignorePatterns: ['^csrf'],
      passwords: { length: 4000 },
      rules: [
        { match: { mode: 'contains', pattern: 'email' }, generator: { type: 'email' } },
        { match: { mode: 'contains', pattern: 'x' }, generator: { type: 'regex' } },
      ],
      profiles: [{ id: 'p1' }],
    };
    const once = parseSettings(messy);
    expect(parseSettings(once)).toEqual(once);
  });
});

describe('agentSettings', () => {
  it('carries the four fields the agent needs and nothing else', () => {
    // BR-024-4. A function rather than a spread, so a setting added for the
    // background alone cannot reach the page by default — this asserts the
    // boundary itself, not just today's contents.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      behaviour: { ...DEFAULT_SETTINGS.behaviour, skipPreFilled: true },
      exclusions: { fields: [{ mode: 'contains', pattern: 'csrf' }], domains: ['bank.test'] },
    };
    const agent = agentSettings(settings);

    expect(Object.keys(agent).sort()).toEqual([
      'dispatchEvents',
      'ignorePatterns',
      'skipHidden',
      'skipPreFilled',
    ]);
    expect(agent.skipPreFilled).toBe(true);
    // Domains stay behind: the background decides whether to run at all, and an
    // agent that never receives the list cannot leak it.
    expect(agent.ignorePatterns).toEqual(['csrf']);
  });

  it('sends exclusions as regex sources, in one vocabulary', () => {
    const agent = agentSettings({
      ...DEFAULT_SETTINGS,
      exclusions: {
        fields: [
          { mode: 'exact', pattern: 'card.number' },
          { mode: 'contains', pattern: 'csrf' },
          { mode: 'regex', pattern: '^tok(en)?$' },
        ],
        domains: [],
      },
    });
    expect(agent.ignorePatterns).toEqual(['^card\\.number$', 'csrf', '^tok(en)?$']);
  });
});

describe('patternSource', () => {
  it('anchors exact, escapes contains, and passes regex through', () => {
    expect(patternSource({ mode: 'exact', pattern: 'a+b' })).toBe('^a\\+b$');
    expect(patternSource({ mode: 'contains', pattern: 'a+b' })).toBe('a\\+b');
    expect(patternSource({ mode: 'regex', pattern: 'a+b' })).toBe('a+b');
  });

  it('produces a pattern that means what the mode says', () => {
    // The translation is only correct if the resulting expression behaves the
    // way the user picking the mode expects, so assert against the regex engine
    // rather than against the string.
    const exact = new RegExp(patternSource({ mode: 'exact', pattern: 'card' }), 'i');
    expect(exact.test('card')).toBe(true);
    expect(exact.test('creditcard')).toBe(false);

    const contains = new RegExp(patternSource({ mode: 'contains', pattern: 'card' }), 'i');
    expect(contains.test('creditcard')).toBe(true);
  });
});

describe('escapeRegex', () => {
  it('makes every metacharacter literal', () => {
    const metacharacters = '.*+?^${}()|[]\\';
    expect(new RegExp(`^${escapeRegex(metacharacters)}$`).test(metacharacters)).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(escapeRegex('card number')).toBe('card number');
  });
});
