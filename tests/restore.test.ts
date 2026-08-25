import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, type Rule, type Settings } from '@/lib/settings';
import { isDefaultConfiguration, restoreLoss } from '@/lib/restore';

/**
 * UC-028's analysis: what a restore would discard, and whether it would change
 * anything at all.
 *
 * Both halves are for the confirmation, and the confirmation is the use case —
 * BR-028-2's whole claim is that the numbers on screen are the numbers the
 * write will make true. A count that drifted from the state it described would
 * be worse than no count, for the same reason an import preview that disagreed
 * with the import would be (BR-026-5).
 */

const rule = (id: string): Rule => ({
  id,
  label: `Rule ${id}`,
  enabled: true,
  match: { mode: 'contains', pattern: id },
  generator: { type: 'email' },
  fromPersona: true,
});

const configured = (): Settings => ({
  ...DEFAULT_SETTINGS,
  locale: 'de-CH',
  rules: [rule('a'), rule('b')],
  profiles: [
    {
      id: 'p1',
      label: 'Staging',
      enabled: true,
      urls: ['https://staging.example.com/*'],
      rules: [rule('p1r1')],
    },
  ],
  exclusions: {
    fields: [{ mode: 'exact', pattern: 'coupon' }],
    domains: ['*.bank.example'],
  },
});

describe('restoreLoss', () => {
  it('counts the four lists the confirmation names (BR-028-2)', () => {
    expect(restoreLoss(configured())).toEqual({
      rules: 2,
      profiles: 1,
      fieldExclusions: 1,
      domainExclusions: 1,
    });
  });

  it('counts a profile’s rules inside the profile, as the import preview does', () => {
    // Three rules in the profile and none outside: the rules count stays at
    // zero, because "1 profile" is what losing them costs and a fifth number
    // would split one fact across two counts.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      profiles: [{ ...configured().profiles[0]!, rules: [rule('x'), rule('y'), rule('z')] }],
    };
    expect(restoreLoss(settings)).toEqual({
      rules: 0,
      profiles: 1,
      fieldExclusions: 0,
      domainExclusions: 0,
    });
  });

  it('is all zeros for the shipped state', () => {
    expect(restoreLoss(DEFAULT_SETTINGS)).toEqual({
      rules: 0,
      profiles: 0,
      fieldExclusions: 0,
      domainExclusions: 0,
    });
  });
});

describe('isDefaultConfiguration', () => {
  it('is true of the shipped state', () => {
    expect(isDefaultConfiguration(DEFAULT_SETTINGS)).toBe(true);
  });

  it('is false when any list holds an entry', () => {
    expect(isDefaultConfiguration({ ...DEFAULT_SETTINGS, rules: [rule('a')] })).toBe(false);
    expect(isDefaultConfiguration({ ...DEFAULT_SETTINGS, profiles: configured().profiles })).toBe(false);
    expect(
      isDefaultConfiguration({
        ...DEFAULT_SETTINGS,
        exclusions: { ...DEFAULT_SETTINGS.exclusions, fields: [{ mode: 'contains', pattern: 'x' }] },
      }),
    ).toBe(false);
    expect(
      isDefaultConfiguration({
        ...DEFAULT_SETTINGS,
        exclusions: { ...DEFAULT_SETTINGS.exclusions, domains: ['*.example.com'] },
      }),
    ).toBe(false);
  });

  it('is false when any scalar setting has moved off its shipped value', () => {
    // Every section the confirmation says resets, one value each. A2's sentence
    // is only honest if the check behind it covers everything that sentence
    // names — a locale that is not "auto" is as much a change as a rule is.
    for (const changed of [
      { locale: 'de-CH' },
      { passwords: { ...DEFAULT_SETTINGS.passwords, length: 20 } },
      { sources: { ...DEFAULT_SETTINGS.sources, className: true } },
      { triggers: { contextMenu: false } },
      { behaviour: { ...DEFAULT_SETTINGS.behaviour, skipHidden: false } },
    ] as Partial<Settings>[]) {
      expect(isDefaultConfiguration({ ...DEFAULT_SETTINGS, ...changed })).toBe(false);
    }
  });

  it('is true of a state that differs only by what the parser drops', () => {
    // The state between adding a rule and typing its pattern: the parser drops
    // a rule with an empty pattern, so this state parses to the shipped one
    // and answers "nothing to discard" truthfully (A2). A raw comparison
    // against DEFAULT_SETTINGS would call it configured and put a count of one
    // rule on a screen about to say nothing is discarded.
    const halfWritten: Settings = {
      ...DEFAULT_SETTINGS,
      rules: [{ ...rule('new'), match: { mode: 'contains', pattern: '' } }],
    };
    expect(isDefaultConfiguration(halfWritten)).toBe(true);
  });

  it('is true of junk keys, which storage would not keep either', () => {
    // Written by hand or by another build; the parser drops unknown keys, so
    // the state this page would load from it is the shipped one.
    const withJunk = parseSettings({ ...DEFAULT_SETTINGS, wobble: 3, behaviour: { dispatchEvents: true, junk: true } });
    expect(isDefaultConfiguration(withJunk)).toBe(true);
  });

  it('answers by value, not by whichever key order a producer emitted', () => {
    // Both sides have to go through the parser, for the reason the options
    // page's storage listener does the same (BR-024-3): `JSON.stringify` is
    // key-order sensitive, and `DEFAULT_SETTINGS` is a literal in one file
    // while `parseSettings` emits in its own order. Comparing parser output
    // against the literal's order answers who wrote each object rather than
    // what either says — and if the two orders ever drift apart, A2's "your
    // settings already are the shipped ones" quietly stops being reachable,
    // which is the benign direction and therefore the one nobody notices.
    expect(isDefaultConfiguration(parseSettings(DEFAULT_SETTINGS))).toBe(true);

    // The same value with its top-level keys reversed, as a state that arrived
    // by a route other than the literal — read back from storage, say, where
    // nothing promises the literal's order: still the shipped configuration.
    const reordered = parseSettings(
      JSON.parse(JSON.stringify(DEFAULT_SETTINGS, Object.keys(DEFAULT_SETTINGS).reverse())),
    );
    expect(isDefaultConfiguration(reordered)).toBe(true);
  });
});
