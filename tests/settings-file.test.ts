import { describe, expect, it } from 'vitest';
import { serialiseSettings, settingsFileName } from '@/lib/settings-file';
import {
  DEFAULT_SETTINGS,
  MATCH_SOURCES,
  parseSettings,
  type Rule,
  type Settings,
} from '@/lib/settings';

/**
 * UC-025's file, checked against the rules the use case states as promises.
 *
 * The interesting failure of this module is not an exception. It is a file that
 * looks entirely correct — valid JSON, every section present — and means
 * something other than the configuration it came from: a generator missing its
 * configuration, an inheriting rule exported as a pinned one, or two identical
 * configurations serialising differently so that every export is a diff. None of
 * those announce themselves at either end, which is why they are asserted here
 * rather than left to the harness.
 *
 * `scripts/e2e-export.mjs` covers what this cannot: that the bytes reach a file
 * on disk, through a real browser, with no `downloads` permission.
 */

/**
 * A configuration exercising the parts of the schema that are easy to serialise
 * wrongly — every generator arm, both rule lists, an inheriting rule beside a
 * pinned one, and non-ASCII text in a label.
 */
function configured(): Settings {
  const rule = (id: string, extra: Partial<Rule>): Rule => ({
    id,
    label: `Rule ${id}`,
    enabled: true,
    match: { mode: 'contains', pattern: id },
    generator: { type: 'email' },
    fromPersona: true,
    ...extra,
  });

  return {
    ...DEFAULT_SETTINGS,
    locale: 'de-CH',
    rules: [
      // A German label with an ß, because BR-025-4 is a promise about exactly
      // this and the corpus ships a locale full of them.
      rule('a', { label: 'Kundenstraße', generator: { type: 'name', part: 'first' } }),
      rule('b', { sources: ['name', 'label'], generator: { type: 'regex', pattern: '[A-Z]{3}' } }),
      rule('c', { generator: { type: 'number', min: 1, max: 9, decimals: 2 } }),
      rule('d', { generator: { type: 'list', items: ['one', 'two'] } }),
      rule('e', { enabled: false, generator: { type: 'constant', value: 'fixed' } }),
      rule('f', { generator: { type: 'date', format: 'YYYY-MM-DD', from: '2000-01-01', to: '2020-01-01' } }),
      rule('g', { generator: { type: 'text', minWords: 2, maxWords: 8 } }),
      rule('h', { generator: { type: 'alphanumeric', template: 'AA-999' } }),
    ],
    profiles: [
      {
        id: 'p1',
        label: 'Staging',
        enabled: true,
        urls: ['https://staging.example.com/*'],
        rules: [rule('p1r1', { generator: { type: 'username' } })],
      },
    ],
    exclusions: {
      fields: [{ mode: 'regex', pattern: '^coupon$' }],
      domains: ['*.bank.example'],
    },
    behaviour: {
      ...DEFAULT_SETTINGS.behaviour,
      skipPreFilled: true,
      maxLengths: { textarea: 200, text: 40 },
    },
  };
}

describe('the exported file', () => {
  it('carries every section and the schema version (BR-025-1, BR-025-6)', () => {
    const file: unknown = JSON.parse(serialiseSettings(configured()));

    expect(Object.keys(file as object)).toEqual([
      'version',
      'locale',
      'rules',
      'profiles',
      'exclusions',
      'behaviour',
      'passwords',
      'sources',
      'triggers',
    ]);
    expect((file as Settings).version).toBe(1);
  });

  it('exports the shipped defaults as a complete configuration (A3)', () => {
    // A3: exporting before writing a single rule is not an empty file. It is a
    // file that restores "the extension as it ships", which is a useful thing to
    // keep — and the section list proves it rather than the byte count.
    const file = JSON.parse(serialiseSettings(DEFAULT_SETTINGS)) as Settings;

    expect(Object.keys(file)).toHaveLength(9);
    expect(file.rules).toEqual([]);
    expect(file.behaviour.consentKeywords.length).toBeGreaterThan(0);
    expect(Object.keys(file.sources)).toEqual([...MATCH_SOURCES]);
  });

  it('is byte-identical for a configuration that has not changed (BR-025-3)', () => {
    const settings = configured();
    expect(serialiseSettings(settings)).toBe(serialiseSettings(settings));
  });

  it('does not depend on the order the state was assembled in (BR-025-3)', () => {
    const settings = configured();

    // The same configuration, with its own keys inserted in a different order —
    // which is what a state that has been through storage and the tolerant
    // parser on another machine may well look like. `JSON.stringify` follows
    // insertion order, so this is the assertion that the file's order is the
    // schema's rather than the object's.
    const shuffled = {
      triggers: settings.triggers,
      sources: reversedKeys(settings.sources),
      passwords: settings.passwords,
      behaviour: { ...settings.behaviour, maxLengths: { text: 40, textarea: 200 } },
      exclusions: settings.exclusions,
      profiles: settings.profiles,
      rules: settings.rules,
      locale: settings.locale,
      version: settings.version,
    } as Settings;

    expect(serialiseSettings(shuffled)).toBe(serialiseSettings(settings));
  });

  it('writes non-ASCII text as itself, not as escapes (BR-025-4)', () => {
    const text = serialiseSettings(configured());

    expect(text).toContain('Kundenstraße');
    expect(text).not.toContain('\\u00df');
  });

  it('is pretty-printed with two spaces and ends in a newline (BR-025-4)', () => {
    const text = serialiseSettings(DEFAULT_SETTINGS);

    expect(text).toContain('\n  "version": 1,');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('carries the password policy and no password (BR-025-5)', () => {
    const file = JSON.parse(serialiseSettings(configured())) as Settings;

    // The whole policy, and *only* the policy. A key added to this section later
    // that happens to hold a value rather than a rule about values would fail
    // here, which is the point: the file is what leaves the machine.
    expect(Object.keys(file.passwords)).toEqual(['length', 'upper', 'lower', 'digits', 'symbols']);
  });

  it('leaves an inheriting rule inheriting (FR-067)', () => {
    const file = JSON.parse(serialiseSettings(configured())) as Settings;
    const [inheriting, pinned] = file.rules;

    // Absent, not resolved. Writing today's global toggles into every rule would
    // change what the configuration does on the machine it is imported onto.
    expect(inheriting).toBeDefined();
    expect(Object.keys(inheriting ?? {})).not.toContain('sources');
    expect(pinned?.sources).toEqual(['name', 'label']);
  });

  it("keeps every generator's configuration with it", () => {
    const file = JSON.parse(serialiseSettings(configured())) as Settings;

    // A generator exported as its `type` alone reads back through the tolerant
    // parser as a *different* generator with default bounds, silently. This is
    // the assertion that each arm carries its own fields.
    expect(file.rules.map((rule) => rule.generator)).toEqual([
      { type: 'name', part: 'first' },
      { type: 'regex', pattern: '[A-Z]{3}' },
      { type: 'number', min: 1, max: 9, decimals: 2 },
      { type: 'list', items: ['one', 'two'] },
      { type: 'constant', value: 'fixed' },
      { type: 'date', format: 'YYYY-MM-DD', from: '2000-01-01', to: '2020-01-01' },
      { type: 'text', minWords: 2, maxWords: 8 },
      { type: 'alphanumeric', template: 'AA-999' },
    ]);
  });

  it('reads back as the configuration it was written from', () => {
    // The claim UC-025 and UC-026 make together, and the one that makes the rest
    // of this file matter: the pair is one format seen from both ends. Compared
    // through the parser on both sides so the comparison is between two states
    // in the same normal form.
    const settings = configured();
    const reloaded = parseSettings(JSON.parse(serialiseSettings(settings)));

    expect(reloaded).toEqual(parseSettings(settings));
  });

  it('names the file for the extension and the schema version (step 4)', () => {
    // No clock and no counter: two exports of an unchanged configuration offer
    // the same name, and the browser's own de-duplication is what tells them
    // apart — where the user can see it happening.
    expect(settingsFileName(DEFAULT_SETTINGS)).toBe('fieldfiller-settings-v1.json');
  });
});

/** A record rebuilt with its keys in the opposite order, values untouched. */
function reversedKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).reverse());
}
