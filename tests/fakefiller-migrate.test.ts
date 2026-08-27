import { describe, expect, it } from 'vitest';
import { analyseMigration } from '@/lib/fakefiller-migrate';
import { looksLikeFakeFiller } from '@/lib/fakefiller-recognise';
import { analyseImport, MAX_IMPORT_SIZE } from '@/lib/settings-import';
import { serialiseSettings } from '@/lib/settings-file';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '@/lib/settings';

/**
 * UC-027's analysis: what a migration would do, before it does it.
 *
 * The failure this file is really guarding against is quieter than UC-026's.
 * The importer's hazard was silence about an unrecognised file; the
 * migration's is a *lookalike* — a backup translated into something that
 * stores cleanly and behaves differently from what the user configured
 * (BR-027-5). Every assertion below is therefore about one of three
 * things: the translation is faithful where it claims to be, the losses
 * are named where it is not, and nothing is guessed into an active state.
 */

/** One backup field, in the reference's documented shape (§2.2 of the research). */
const field = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'text',
  name,
  match: [name],
  ...extra,
});

/**
 * A whole backup, version 1 by default.
 *
 * Deliberately minimal — `version` and the two lists and nothing else —
 * because the reference's *documented defaults* (a `defaultMaxLength`, a
 * random password mode, the full `fieldMatchSettings`) are each worth a
 * note in their own right, and a fixture that carries them would put two
 * standing notes on every plan below, burying the one each test is about.
 * Tests that translate those settings state them.
 */
const backup = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  fields: [],
  profiles: [],
  ...extra,
});

/** The current configuration a migration would replace. */
const current = (): Settings => ({
  ...DEFAULT_SETTINGS,
  rules: [
    { ...ruleOf('existing'), id: 'existing', label: 'existing' },
  ],
});

const ruleOf = (pattern: string): Settings['rules'][number] => ({
  id: pattern,
  label: pattern,
  enabled: true,
  match: { mode: 'contains', pattern },
  generator: { type: 'email' },
  fromPersona: true,
});

const analyse = (file: unknown, now: Settings = current()) =>
  analyseMigration(JSON.stringify(file), now);

/** The loss codes on a field note, as `code:params` strings for `toContain`. */
function lossText(note: { losses?: readonly { code: string; params: readonly string[] }[] } | undefined): string {
  return (note?.losses ?? []).map((loss) => `${loss.code}:${loss.params.join(',')}`).join(' ');
}

describe('refusing a file (A1)', () => {
  it('refuses text that is neither JSON nor the reference’s Base64 transport, saying which', () => {
    const outcome = analyseMigration('{ not json', current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedNotJson');
    expect(outcome.refusal.params[0]).toBeTruthy();
  });

  it('refuses Base64 that does not decode to JSON', () => {
    // Decodes fine, parses as nothing. A1's "which of the two it was".
    const outcome = analyseMigration(btoa('plainly not json at all'), current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedNotJson');
  });

  it('refuses JSON that is not an object (A1)', () => {
    for (const value of [[], 42, 'backup', null]) {
      const outcome = analyse(value);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.refusal.code).toBe('migrateRefusedNotObject');
    }
  });

  it('refuses a file carrying none of the reference’s keys (A1, BR-027-2)', () => {
    const outcome = analyse({ hello: 'world' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedNotBackup');
  });

  it('refuses a file holding only keys both schemas share', () => {
    // `version` and `profiles` are ours too, so recognition cannot run on
    // them; a file carrying only those names nobody distinctive is not a
    // backup this translation was written against.
    const outcome = analyse({ version: 1, profiles: [] });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedNotBackup');
  });

  it('refuses this extension’s own export by pointing back at import (A1 step 2)', () => {
    const outcome = analyseMigration(serialiseSettings(current()), current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedOurs');
  });

  it('refuses a file past the bound before reading it (A8)', () => {
    const outcome = analyseMigration('x'.repeat(MAX_IMPORT_SIZE + 1), current());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('migrateRefusedTooLarge');
    // UC-026 A9's numbers, not a second bound the two surfaces could disagree about.
    expect(outcome.refusal.params[1]).toBe(String(Math.ceil(MAX_IMPORT_SIZE / 1024)));
  });
});

describe('reading the reference’s transport (step 2)', () => {
  it('reads a Base64-encoded backup exactly as its JSON twin', () => {
    const file = backup({ fields: [field('phone', { type: 'telephone' })] });
    const encoded = analyseMigration(btoa(JSON.stringify(file)), current());
    const plain = analyse(file);

    expect(encoded).toEqual(plain);
    expect(encoded.ok).toBe(true);
  });

  it('tolerates the padding a hand-copied .txt may have lost', () => {
    const file = backup({ fields: [field('email', { type: 'email' })] });
    const encoded = btoa(JSON.stringify(file)).replace(/=+$/, '');

    const outcome = analyseMigration(encoded, current());
    expect(outcome.ok).toBe(true);
  });
});

describe('recognising the source (step 3)', () => {
  it('recognises any one of the reference’s unambiguous keys', () => {
    for (const key of ['fields', 'ignoredFields', 'passwordSettings', 'triggerClickEvents']) {
      expect(looksLikeFakeFiller({ [key]: true })).toBe(true);
    }
  });

  it('does not recognise a file of ours on a shared key name', () => {
    // `version` and `profiles` exist on both sides of the mirror; recognition
    // must not fire on them, or our own exports would be migratable.
    expect(looksLikeFakeFiller({ version: 1, profiles: [] })).toBe(false);
  });
});

describe('translating fields (the mapping table)', () => {
  it('maps the name types to parts of the name generator, exactly', () => {
    const outcome = analyse(
      backup({
        fields: [
          field('first', { type: 'first-name' }),
          field('last', { type: 'last-name' }),
          field('full', { type: 'full-name' }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const parts = outcome.plan.settings.rules.map((rule) => rule.generator);
    expect(parts).toEqual([
      { type: 'name', part: 'first' },
      { type: 'name', part: 'last' },
      { type: 'name', part: 'full' },
    ]);
    // BR-027-4: what maps exactly leaves no note behind.
    expect(outcome.plan.noted).toEqual([]);
  });

  it('maps the reference’s spelling of organization and the simple types', () => {
    const outcome = analyse(
      backup({
        fields: [
          field('org', { type: 'organization' }),
          field('user', { type: 'username' }),
          field('site', { type: 'url' }),
          field('mail', { type: 'email' }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules.map((rule) => rule.generator.type)).toEqual([
      'organisation',
      'username',
      'url',
      'email',
    ]);
  });

  it('names every email customisation the entry actually carried (A3)', () => {
    const outcome = analyse(
      backup({
        fields: [
          field('mail', {
            type: 'email',
            emailPrefix: 'qa-',
            emailHostname: 'list',
            emailHostnameList: ['example.com'],
            emailUsername: 'regex',
            emailUsernameRegEx: '^qa',
          }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Named per rule, as a sentence about the rule the user recognises —
    // not a count (A3 step 2).
    expect(outcome.plan.noted).toHaveLength(1);
    expect(outcome.plan.noted[0]?.code).toBe('migrateNotedField');
    expect(outcome.plan.noted[0]?.params[0]).toBe('mail');
    const losses = lossText(outcome.plan.noted[0]);
    expect(losses).toContain('migrateLossSetting:emailPrefix');
    expect(losses).toContain('migrateLossSetting:emailHostname');
    expect(losses).toContain('migrateLossSetting:emailUsernameRegEx');
    // Keys the entry did not carry are not invented as losses.
    expect(losses).not.toContain('migrateLossSetting:emailUsernameList');
  });

  it('names a telephone template, and carries the rule', () => {
    const outcome = analyse(
      backup({ fields: [field('phone', { type: 'telephone', template: '+1 (XxX) XxX-XxxX' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toEqual({ type: 'telephone' });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossTelephoneTemplate:+1 (XxX) XxX-XxxX');
  });

  it('carries number bounds that fit, and names the ones ours moves', () => {
    const outcome = analyse(
      backup({
        fields: [
          field('age', { type: 'number', min: 18, max: 99, decimalPlaces: 0 }),
          field('huge', { type: 'number', min: 1e300, max: 5e300 }),
          field('reversed', { type: 'number', min: 99, max: 18 }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rules = outcome.plan.settings.rules;
    expect(rules[0]?.generator).toEqual({ type: 'number', min: 18, max: 99, decimals: 0 });

    // A bound ours clamps is named as arriving changed, before the write.
    const huge = rules[1]?.generator;
    expect(huge).toMatchObject({ min: 1e15, max: 1e15 });
    expect(
      outcome.plan.noted.some((note) => lossText(note).includes('migrateLossClamped:min,1e+300')),
    ).toBe(true);

    // A reversed range arrives ordered and says so.
    expect(rules[2]?.generator).toMatchObject({ min: 18, max: 99 });
    expect(outcome.plan.noted.some((note) => lossText(note).includes('migrateLossRangeReordered'))).toBe(true);
  });

  it('names a text field’s character cap that has no word-count equivalent', () => {
    const outcome = analyse(backup({ fields: [field('bio', { type: 'text', maxLength: 40 })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toEqual({
      type: 'text',
      minWords: 5,
      maxWords: 20,
    });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossMaxLength:40');
  });

  it('translates a randomized list exactly', () => {
    const outcome = analyse(
      backup({ fields: [field('plan', { type: 'randomized-list', list: ['basic', 'pro'] })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toEqual({
      type: 'list',
      items: ['basic', 'pro'],
    });
    expect(outcome.plan.noted).toEqual([]);
  });

  it('drops a randomized list with nothing in it', () => {
    const outcome = analyse(backup({ fields: [field('plan', { type: 'randomized-list', list: [] })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toEqual([]);
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedField');
  });

  it('drops a field of a type outside the documented fourteen', () => {
    const outcome = analyse(backup({ fields: [field('odd', { type: 'ibans' })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedFieldUnknownType');
    expect(outcome.plan.dropped[0]?.params).toEqual(['odd', 'ibans']);
  });
});

describe('joining the reference’s pattern lists (BR-027-3)', () => {
  it('joins several patterns into one alternation, wrapped non-capturing', () => {
    const outcome = analyse(
      backup({ fields: [field('contact', { type: 'telephone', match: ['phone', 'fax', 'tel'] })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.match).toEqual({
      mode: 'regex',
      pattern: '(?:phone)|(?:fax)|(?:tel)',
    });
  });

  it('drops the rule when the join fails validation, naming every pattern that went in (A4)', () => {
    // The reference never screened a pattern in its life. One catastrophic
    // pattern hides among honest ones — and the report names the whole
    // list, because "the rule" was the user's whole list.
    const outcome = analyse(
      backup({
        fields: [
          field('danger', { type: 'text', match: ['address', '(a+)+b', 'street'] }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toEqual([]);
    expect(outcome.plan.dropped).toHaveLength(1);
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedFieldRefused');
    expect(outcome.plan.dropped[0]?.params[0]).toBe('danger');
    expect(outcome.plan.dropped[0]?.params[1]).toBe('address | (a+)+b | street');
    // The fault itself, carried as the editor words it (A4 step 1).
    expect(outcome.plan.dropped[0]?.problem?.code).toBe('ruleProblemPatternBacktracks');
  });

  it('drops a field whose match list is empty, for that reason', () => {
    const outcome = analyse(backup({ fields: [field('nothing', { match: [] })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedFieldNoMatch');
  });

  it('refuses a regex generator the editor would refuse, with the editor’s own words', () => {
    const outcome = analyse(
      backup({ fields: [field('ref', { type: 'regex', template: '(a+)+b' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedFieldRefused');
    expect(outcome.plan.dropped[0]?.problem?.code).toBe('ruleProblemGeneratorBacktracks');
  });
});

describe('translating templates', () => {
  it('translates the date tokens ours shares, exactly (BR-027-4)', () => {
    const outcome = analyse(
      backup({
        fields: [field('when', { type: 'date', template: 'DD/MM/YYYY HH:mm:ss' })],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: 'DD/MM/YYYY HH:mm:ss' });
    // Exact tokens, no note: what maps exactly is stated as mapping exactly.
    expect(outcome.plan.noted).toEqual([]);
  });

  it('carries moment’s bracket literals as our literals', () => {
    const outcome = analyse(
      backup({ fields: [field('when', { type: 'date', template: '[on] YYYY-MM-DD' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: 'on YYYY-MM-DD' });
  });

  it('keeps a date template’s literal braces literal, not doubled for another grammar', () => {
    // The date grammar has no brace escape — formatDate passes every
    // character outside its tokens through as an ordinary literal — so
    // doubling braces here (the alphanumeric grammar's rule, where {{ is
    // how a literal brace is written) made every generated date render
    // {{}} where the backup said {}. Two grammars that disagree about
    // braces do not share an escaper.
    const outcome = analyse(
      backup({ fields: [field('when', { type: 'date', template: '[{}] YYYY-MM-DD' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: '{} YYYY-MM-DD' });
    // And nothing about it is a loss — the braces are carried, exactly.
    expect(lossText(outcome.plan.noted[0])).not.toContain('{');
  });

  it('drops and names a literal that hides the grammar’s own tokens, rather than letting it half-substitute', () => {
    // `[summertime]` is a moment literal; this grammar has no escape, and
    // formatDate substitutes `mm` *anywhere* — so emitting the literal raw
    // put the minutes of a random date inside the word, on every generated
    // date, with no loss named. The homeless-token precedent, applied to
    // the one place tokens can hide: token-bearing characters dropped and
    // named, the rest of the literal carried.
    const outcome = analyse(
      backup({ fields: [field('when', { type: 'date', template: 'DD [summertime] YYYY' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: 'DD suertime YYYY' });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossDateToken:mm');
    // And no ruleProblemDateNoToken either way: a token-bearing format
    // survives save-time validation precisely because of the hiding.
    expect(outcome.plan.dropped).toEqual([]);
  });

  it('takes an impossible-date bound down the named path, not the refused-rule one', () => {
    // 2026-02-31 parses on engines that roll impossible dates forward (this
    // V8 still does) and is NaN on engines following the tightened parsing
    // spec — engine-dependent either way, which is why the bound is asked
    // through `isIsoDate`, the same engine-independent round-trip
    // `validateRule` uses. Until it was, the rolling engines accepted the
    // bound here and then `validateRule` refused the whole field as
    // "cannot be stored" — the misleading outcome, two functions answering
    // one question differently.
    const outcome = analyse(
      backup({
        fields: [
          field('when', { type: 'date', template: 'YYYY-MM-DD', minDate: '2026-02-31' }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toHaveLength(1);
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ from: '1970-01-01' });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossDateBound:minDate,2026-02-31');
    expect(outcome.plan.dropped).toEqual([]);
  });

  it('maps a full month name to the nearest token and names it', () => {
    const outcome = analyse(
      backup({ fields: [field('when', { type: 'date', template: 'MMMM YYYY' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // MMMM cannot pass through as a literal — our own MMM token matches
    // inside it — so it becomes the nearest token, named (the module note's
    // recorded deviation from the table's letter).
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: 'MMM YYYY' });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossDateToken:MMMM');
  });

  it('drops homeless date tokens rather than emitting junk, naming each', () => {
    const outcome = analyse(
      backup({ fields: [field('when', { type: 'date', template: 'HH:mm A' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // `A` (AM/PM) has no counterpart; a literal would put "PM" in every
    // generated date, so it is omitted and named.
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({ format: 'HH:mm ' });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossDateToken:A');
  });

  it('translates date bounds that parse as ISO, and names the rest', () => {
    const outcome = analyse(
      backup({
        fields: [
          field('born', {
            type: 'date',
            template: 'YYYY-MM-DD',
            minDate: '1980-01-01',
            maxDate: '01/03/2020',
          }),
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({
      from: '1980-01-01',
      // A moment-style date is not a number this side may reinterpret: the
      // default bound stands and the loss is named (BR-027-5).
      to: '2035-12-31',
    });
    expect(lossText(outcome.plan.noted[0])).toContain('migrateLossDateBound:maxDate,01/03/2020');
  });

  it('translates alphanumeric placeholders exactly where ours shares them', () => {
    const outcome = analyse(
      backup({ fields: [field('serial', { type: 'alphanumeric', template: 'LLL-xxx' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toEqual({
      type: 'alphanumeric',
      template: '{upper}{upper}{upper}-{digit}{digit}{digit}',
    });
    expect(outcome.plan.noted).toEqual([]);
  });

  it('maps near-miss alphanumeric tokens to the nearest placeholder and names them', () => {
    const outcome = analyse(
      backup({ fields: [field('serial', { type: 'alphanumeric', template: 'CVX-[fixed]' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The `-` between the placeholders and the literal is the reference's
    // own rule for unknown characters — a literal — so it arrives as one.
    expect(outcome.plan.settings.rules[0]?.generator).toEqual({
      type: 'alphanumeric',
      template: '{consonant}{vowel}{digit}-fixed',
    });
    const losses = lossText(outcome.plan.noted[0]);
    expect(losses).toContain('migrateLossUpperConsonant');
    expect(losses).toContain('migrateLossUpperVowel');
    expect(losses).toContain('migrateLossNonzeroDigit');
  });

  it('escapes braces arriving inside an alphanumeric literal', () => {
    const outcome = analyse(
      backup({ fields: [field('serial', { type: 'alphanumeric', template: 'x[{}]x' })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.generator).toMatchObject({
      template: '{digit}{{}}{digit}',
    });
  });
});

describe('translating profiles (A5, BR-027-5)', () => {
  it('translates a profile’s rules and arrives the profile disabled, named', () => {
    const outcome = analyse(
      backup({
        fields: [field('global')],
        profiles: [
          {
            name: 'Staging',
            urlMatch: '.*\\.staging\\.example\\.com.*',
            fields: [field('internal', { type: 'username' })],
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const profile = outcome.plan.settings.profiles[0];
    expect(profile).toMatchObject({ label: 'Staging', enabled: false, urls: [] });
    expect(profile?.rules).toHaveLength(1);
    expect(outcome.plan.incoming.profiles).toBe(1);
    // Named, with the pattern the user recognises, before the write.
    const note = outcome.plan.noted.find((entry) => entry.code === 'migrateNotedProfileUrl');
    expect(note?.params).toEqual(['Staging', '.*\\.staging\\.example\\.com.*']);
  });

  it('a profile with no URL match is reported as unrestricted, not as quoting a regex it never set', () => {
    // The reference’s absent-or-empty urlMatch applies the profile on every
    // page; a sentence asserting 'its URL match "" is a regular expression'
    // about that is a false claim about the backup. Both states arrive
    // disabled (A5’s uniform rule); the words say why, truthfully.
    for (const profile of [
      { name: 'Absent', fields: [] },
      { name: 'Empty', urlMatch: '', fields: [] },
    ]) {
      const outcome = analyse(backup({ profiles: [profile] }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.plan.settings.profiles[0]?.enabled).toBe(false);
      const note = outcome.plan.noted.find(
        (entry) => entry.code === 'migrateNotedProfileUrlUnrestricted',
      );
      expect(note?.params).toEqual([profile.name]);
      // And the regex-quoting sentence is not made about it.
      expect(outcome.plan.noted.some((entry) => entry.code === 'migrateNotedProfileUrl')).toBe(false);
    }
  });

  it('names losses on a profile’s own rules, with the profile', () => {
    const outcome = analyse(
      backup({
        profiles: [
          {
            name: 'Checkout',
            urlMatch: '^checkout',
            fields: [field('mail', { type: 'email', emailPrefix: 'qa-' })],
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const note = outcome.plan.noted.find((entry) => entry.code === 'migrateNotedProfileField');
    expect(note?.params[0]).toBe('Checkout');
    expect(note?.params[1]).toBe('mail');
    expect(lossText(note)).toContain('migrateLossSetting:emailPrefix');
  });

  it('drops a profile rule that fails validation, with the profile named', () => {
    const outcome = analyse(
      backup({
        profiles: [
          { name: 'Odd', urlMatch: 'odd', fields: [field('bad', { type: 'regex', template: '(a+)+b' })] },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.profiles[0]?.rules).toEqual([]);
    expect(outcome.plan.dropped[0]?.code).toBe('migrateDroppedProfileFieldRefused');
    expect(outcome.plan.dropped[0]?.params[0]).toBe('Odd');
  });
});

describe('translating the root settings', () => {
  it('carries the user’s source toggles, including class left on (BR-027-7)', () => {
    const outcome = analyse(
      backup({
        fieldMatchSettings: {
          matchClass: true,
          matchName: false,
          matchId: true,
          matchLabel: true,
          matchPlaceholder: false,
          matchAriaLabel: true,
          matchAriaLabelledBy: true,
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.sources).toEqual({
      ...DEFAULT_SETTINGS.sources,
      // Preserved as set, not overridden by our default: overriding an
      // explicit choice would be the quiet configuration loss this use
      // case exists to prevent.
      className: true,
      name: false,
      placeholder: false,
    });
  });

  it('resolves an aria split onto the wider setting and names it', () => {
    const outcome = analyse(
      backup({
        fieldMatchSettings: {
          matchClass: true,
          matchId: true,
          matchLabel: true,
          matchName: true,
          matchPlaceholder: true,
          matchAriaLabel: true,
          matchAriaLabelledBy: false,
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.sources.ariaLabel).toBe(true);
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedSourcesSplit')).toBe(true);
  });

  it('carries ignoredFields as regex-mode exclusions', () => {
    const outcome = analyse(backup({ ignoredFields: ['captcha', 'hipinputtext'] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.exclusions.fields).toEqual([
      { mode: 'regex', pattern: 'captcha' },
      { mode: 'regex', pattern: 'hipinputtext' },
    ]);
  });

  it('names an ignored-field pattern the matcher refuses, and keeps it (the importer’s one-answer rule)', () => {
    // The reference never screened its patterns, so a backup is as likely to
    // carry `(a+)+b` in `ignoredFields` as in a field's match list — and
    // until this note existed the same file got two answers from one build:
    // the rule refused and named (A4), the exclusion stored in silence.
    // Kept rather than refused, on the exclusion editor's terms: the list
    // stores invalid patterns on purpose, and a migration must not be
    // stricter than the screen that corrects them.
    const outcome = analyse(backup({ ignoredFields: ['captcha', '(a+)+b'] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.exclusions.fields).toEqual([
      { mode: 'regex', pattern: 'captcha' },
      { mode: 'regex', pattern: '(a+)+b' },
    ]);
    const note = outcome.plan.noted.find((entry) => entry.code === 'migrateNotedExclusion');
    expect(note?.params).toEqual(['(a+)+b']);
    expect(note?.problem?.code).toBe('ruleProblemPatternBacktracks');
    // And only the faulty one — an honest pattern earns no line.
    expect(outcome.plan.noted.filter((entry) => entry.code === 'migrateNotedExclusion')).toHaveLength(1);
  });

  it('splits the keyword lists on commas, including inside entries', () => {
    const outcome = analyse(
      backup({
        agreeTermsFields: ['agree, terms', 'einwilligung'],
        confirmFields: ['repeat'],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.consentKeywords).toEqual(['agree', 'terms', 'einwilligung']);
    expect(outcome.plan.settings.behaviour.confirmationKeywords).toEqual(['repeat']);
  });

  it('keeps an explicitly emptied keyword list empty', () => {
    const outcome = analyse(backup({ agreeTermsFields: [], confirmFields: ['repeat'] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // "Tick nothing for consent" is a configuration, not an accident to undo.
    expect(outcome.plan.settings.behaviour.consentKeywords).toEqual([]);
    // And it earns no loss line: nothing was lost.
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape')).toBe(false);
  });

  it('keeps the shipped words when a non-empty keyword list yields nothing readable, and names it', () => {
    // `[42]` or `["  "]` is a list, so the root shape check passes — and the
    // filter used to turn it into an empty consent list, silently switching
    // off every terms checkbox the user's configuration ticked. An empty
    // list is a *choice* a backup makes with `[]`; garbage is not that
    // choice, so the default stands and the drop says which list it was.
    for (const garbage of [[42], ['   ']]) {
      const outcome = analyse(backup({ agreeTermsFields: garbage }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      // `toEqual`, deliberately not `toBe`: the shipped *words* stand, and
      // the array they arrive in is this plan's own — the reference-scan
      // test below pins that distinction for every section at once.
      expect(outcome.plan.settings.behaviour.consentKeywords).toEqual(DEFAULT_SETTINGS.behaviour.consentKeywords);
      expect(
        outcome.plan.dropped.some(
          (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'agreeTermsFields',
        ),
      ).toBe(true);
    }
  });

  it('carries a partially readable keyword list past its stray garbage, in silence', () => {
    // The boundary `keywordsOf` states: blank fragments between commas are
    // CSV hygiene, and a stray non-string beside readable keywords loses
    // nothing the user can act on. Only the total loss is named, because
    // only the total loss changes what a fill does.
    const outcome = analyse(backup({ agreeTermsFields: ['agree,', 42, ' terms'] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.consentKeywords).toEqual(['agree', 'terms']);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape')).toBe(false);
  });

  it('names an ignoredFields list from which no pattern can be read', () => {
    // The keyword lists' total-loss case, one leaf over: the filter would
    // otherwise manufacture "the user excluded nothing" out of `[42]`.
    const outcome = analyse(backup({ ignoredFields: [42, true] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.exclusions.fields).toEqual([]);
    expect(
      outcome.plan.dropped.some(
        (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'ignoredFields',
      ),
    ).toBe(true);
  });

  it('applies the global length cap to the single-line kinds only, and says so', () => {
    const outcome = analyse(backup({ defaultMaxLength: 12 }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.maxLengths).toEqual({ text: 12, search: 12 });
    // Importing the cap verbatim would import the defect ND-10 replaced —
    // a twelve-character textarea — so the textarea-sized kinds keep the
    // built-in sizing and the report says so.
    expect(outcome.plan.settings.behaviour.maxLengths.textarea).toBeUndefined();
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedDefaultMaxLength')).toBe(true);
  });

  it('emits length caps whose keys survive storage’s alphabetising unchanged', () => {
    // `chrome.storage.local` hands a stored state back with every object’s
    // keys alphabetised, and `maxLengths` is the one record whose keys are
    // data — so a plan whose caps are not already alphabetical comes back
    // reordered, fails the options page’s is-this-our-write comparison, and
    // the adoption announcement talks over the migration’s own. The export
    // path sorts its caps for exactly this reason (BR-025-3); this asserts
    // the plan needs no such second look.
    const outcome = analyse(backup({ defaultMaxLength: 12 }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const caps = outcome.plan.settings.behaviour.maxLengths;
    expect(Object.keys(caps)).toEqual([...Object.keys(caps)].sort());
    // And the page’s own comparison, spelled the way main.ts spells it:
    // the stored echo, alphabetised, parsed — against the memory, parsed.
    const alphabetised: Record<string, number> = {};
    for (const key of Object.keys(caps).sort()) alphabetised[key] = caps[key as keyof typeof caps] ?? 0;
    const echo = { ...outcome.plan.settings, behaviour: { ...outcome.plan.settings.behaviour, maxLengths: alphabetised } };
    expect(JSON.stringify(echo)).toBe(JSON.stringify(outcome.plan.settings));
  });

  it('drops no length cap when the backup states none', () => {
    const outcome = analyse(backup({ defaultMaxLength: undefined }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.maxLengths).toEqual({});
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedDefaultMaxLength')).toBe(false);
  });

  it('carries the behaviour and trigger switches by their new names', () => {
    const outcome = analyse(
      backup({
        triggerClickEvents: false,
        ignoreHiddenFields: false,
        ignoreFieldsWithContent: true,
        enableContextMenu: false,
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.dispatchEvents).toBe(false);
    expect(outcome.plan.settings.behaviour.skipHidden).toBe(false);
    expect(outcome.plan.settings.behaviour.skipPreFilled).toBe(true);
    expect(outcome.plan.settings.triggers.contextMenu).toBe(false);
  });

  it('drops a defined password string and says what that changes (A6)', () => {
    const outcome = analyse({
      ...backup(),
      passwordSettings: { mode: 'defined', password: 'Pa$$w0rd!' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.passwords).toEqual(DEFAULT_SETTINGS.passwords);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedPasswordDefined')).toBe(true);
    // The chosen string never reaches the report: it is a secret wearing a
    // list item's clothing, and the sentence names the fact, not the value.
    const drop = outcome.plan.dropped.find((entry) => entry.code === 'migrateDroppedPasswordDefined');
    expect(drop?.params).toEqual([]);
  });

  it('carries a random password at the observed length of eight, named', () => {
    const outcome = analyse(backup({ passwordSettings: { mode: 'random', password: '' } }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.passwords).toEqual({ ...DEFAULT_SETTINGS.passwords, length: 8 });
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedPasswordRandom')).toBe(true);
  });

  it('names a mode neither documented value, and the default policy stands', () => {
    // A hand-edit or a store build ahead of the published schema — §4's
    // threat model, one level down from where the root reports apply. Until
    // this, the user's password behaviour was silently replaced by our
    // default with no line in either list.
    for (const mode of ['rnd', 42]) {
      const outcome = analyse(backup({ passwordSettings: { mode, password: 'x' } }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.plan.settings.passwords).toEqual(DEFAULT_SETTINGS.passwords);
      expect(
        outcome.plan.dropped.some(
          (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'passwordSettings.mode',
        ),
      ).toBe(true);
      // Neither the defined drop nor the random note: the mode was not read
      // as either, so neither promise is made.
      expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedPasswordDefined')).toBe(false);
      expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedPasswordRandom')).toBe(false);
    }
  });

  it('names a mistyped fieldMatchSettings toggle, and our default stands rather than a phantom choice', () => {
    // BR-027-7 preserves a *readable* choice against our default; an
    // unreadable one is not a choice, and "as set" of something nobody set
    // is how a quiet default wears a preservation's face.
    const outcome = analyse(backup({ fieldMatchSettings: { matchClass: 'yes' } }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.sources.className).toBe(DEFAULT_SETTINGS.sources.className);
    expect(
      outcome.plan.dropped.some(
        (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'fieldMatchSettings.matchClass',
      ),
    ).toBe(true);
  });

  it('treats an unreadable aria toggle as the wider setting, without the split note', () => {
    // The split note describes a disagreement the backup *made*; a side
    // this build cannot read is a read failure, already named by its shape
    // drop, and must not be reported as a choice. The wider direction is
    // kept — `true` cannot lose a match the backup made.
    const outcome = analyse(backup({ fieldMatchSettings: { matchAriaLabel: 42, matchAriaLabelledBy: false } }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.sources.ariaLabel).toBe(true);
    expect(
      outcome.plan.dropped.some(
        (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'fieldMatchSettings.matchAriaLabel',
      ),
    ).toBe(true);
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedSourcesSplit')).toBe(false);
  });

  it('never hands back the shipped policy object itself', () => {
    // `translateBehaviour` refuses exactly this alias and says why; the
    // policy is the same hazard one function over, and this pins it so the
    // copy cannot be "simplified" back into a reference to the constant's
    // interior. Checked on every mode, because the fix has to hold in the
    // branches nobody edits.
    for (const passwordSettings of [
      undefined,
      { mode: 'defined', password: 'Pa$$w0rd!' },
      { mode: 'random', password: '' },
    ]) {
      const outcome = analyse(backup({ passwordSettings }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.plan.settings.passwords).not.toBe(DEFAULT_SETTINGS.passwords);
    }
  });

  it('shares no object anywhere in the plan with the shipped defaults', () => {
    // The general pin, written after the *fifth* review round found a third
    // instance of the same alias (the keyword arrays — the spread of
    // `DEFAULT_SETTINGS.behaviour` copies the outer object and keeps the
    // inner arrays by reference). Per-instance identity tests catch the
    // instance somebody thought of; this catches the sixth instance without
    // waiting for it. The plan becomes the page's live state after
    // `host.replace`, so any shared node is one in-place mutation away from
    // rewriting the shipped defaults for the page's lifetime.
    const shipped = new Set<unknown>();
    const collect = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || shipped.has(node)) return;
      shipped.add(node);
      for (const child of Object.values(node as Record<string, unknown>)) collect(child);
    };
    collect(DEFAULT_SETTINGS);

    const touches = (node: unknown): boolean => {
      if (typeof node !== 'object' || node === null) return false;
      if (shipped.has(node)) return true;
      return Object.values(node as Record<string, unknown>).some(touches);
    };

    // An empty backup exercises every fallback path at once: every section
    // is either the default (by copy) or built from nothing.
    const outcome = analyse(backup());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(touches(outcome.plan.settings)).toBe(false);
  });

  it('names a root key outside the documented schema', () => {
    const outcome = analyse({ ...backup(), darkMode: true });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedKey' && drop.params[0] === 'darkMode')).toBe(true);
  });

  it('names an unknown key on a field entry, by path', () => {
    // The store build runs ahead of the published source one level down too
    // (§4 of the research), and until this existed a key the documented
    // schema never mentions vanished from both lists. `emailPrefix` on a
    // *number* field — a documented key, carried where it means nothing —
    // is named alongside a genuinely unknown one.
    const outcome = analyse(
      backup({ fields: [field('age', { type: 'number', min: 1, max: 9, emailPrefix: 'qa-', sparkle: true })] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const paths = outcome.plan.dropped.filter((drop) => drop.code === 'migrateDroppedKey').map((drop) => drop.params[0]);
    expect(paths).toContain('fields[0].emailPrefix');
    expect(paths).toContain('fields[0].sparkle');
    // The documented keys of this entry's own type are not losses.
    expect(paths).not.toContain('fields[0].min');
  });

  it('names an unknown key on a profile entry and on its fields', () => {
    const outcome = analyse(
      backup({
        profiles: [
          { name: 'Staging', urlMatch: 's', theme: 'dark', fields: [field('user', { type: 'username', wobble: 1 })] },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const paths = outcome.plan.dropped.filter((drop) => drop.code === 'migrateDroppedKey').map((drop) => drop.params[0]);
    expect(paths).toContain('profiles[0].theme');
    expect(paths).toContain('profiles[0].fields[0].wobble');
  });

  it('names an unknown key inside the two documented object sections, by path', () => {
    // The §4 threat model — the store build runs ahead of the published
    // source — was the stated justification for the root and entry key
    // reports; the two object sections were the one surface it did not
    // reach, and a passwordSettings.someFutureKey vanished from both lists
    // while fields[2].sparkle was named one function over. The importer
    // descends into its sections; this report now does too.
    const outcome = analyse(
      backup({
        passwordSettings: { mode: 'defined', password: 'x', someFutureKey: 1 },
        fieldMatchSettings: { matchName: true, sparkle: true },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const paths = outcome.plan.dropped.filter((drop) => drop.code === 'migrateDroppedKey').map((drop) => drop.params[0]);
    expect(paths).toContain('passwordSettings.someFutureKey');
    expect(paths).toContain('fieldMatchSettings.sparkle');
    // The documented keys are not losses — `password` is named by the A6
    // drop when defined mode reads it, not as an unknown key.
    expect(paths).not.toContain('passwordSettings.password');
    expect(paths).not.toContain('fieldMatchSettings.matchName');
  });

  it('does not pick through an object section that is mistyped whole', () => {
    // A non-object passwordSettings is mistypedRoots' to name; scanning it
    // here too would double-report the same loss.
    const outcome = analyse(backup({ passwordSettings: 'hunter2' }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'passwordSettings'),
    ).toBe(true);
    expect(
      outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedKey' && drop.params[0]?.startsWith('passwordSettings.')),
    ).toBe(false);
  });

  it('drops a garbage profiles[] entry whole rather than translating it into an empty profile', () => {
    // `asRecord` tolerance used to turn a non-object entry into a disabled
    // profile named #n with a urlMatch note — a thing the backup never
    // carried, wearing a successful translation's face.
    const outcome = analyse(backup({ profiles: ['staging', 42, null] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.profiles).toEqual([]);
    expect(outcome.plan.incoming.profiles).toBe(0);
    const drops = outcome.plan.dropped.filter((drop) => drop.code === 'migrateDroppedProfile');
    expect(drops).toHaveLength(3);
    // Named by position: an unreadable entry has no name to translate.
    expect(drops.map((drop) => drop.params[0])).toEqual(['#1', '#2', '#3']);
  });

  it('does not pick through the keys of a dropped field entry', () => {
    // The entry is not arriving; a second line about its unknown keys would
    // inflate the count the user is deciding on (the importer's `reported`
    // discipline).
    const outcome = analyse(
      backup({ fields: [{ type: 'number', name: 'odd', match: [], sparkle: true }] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedFieldNoMatch')).toBe(true);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedKey' && drop.params[0] === 'fields[0].sparkle')).toBe(false);
  });

  it('does not pick through the keys of a field dropped inside a profile either', () => {
    // The global case is pinned above; a profile's field is as much a corpse
    // as a global one, and until the scan learned about it the same entry
    // produced two drops — "lists no match patterns" and a key line for the
    // sparkle key nobody is storing. Found in review.
    const outcome = analyse(
      backup({
        profiles: [
          {
            name: 'Staging',
            urlMatch: 's',
            fields: [{ type: 'text', name: 'x', match: [], sparkle: true }],
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedProfileFieldNoMatch')).toBe(true);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedKey' && drop.params[0] === 'profiles[0].fields[0].sparkle')).toBe(false);
  });

  it('names a profile whose fields are not a list, rather than arriving with its rules silently gone', () => {
    // The tolerant reader answered `fields: 42` with an empty rule list and
    // no line in either report — the user's scoped fields, silently gone.
    // Same family as the keyword lists' total loss, one leaf over.
    const outcome = analyse(
      backup({ profiles: [{ name: 'Staging', urlMatch: 's', fields: 42 }] }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.profiles[0]?.rules).toEqual([]);
    expect(
      outcome.plan.dropped.some(
        (drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'profiles[0].fields',
      ),
    ).toBe(true);
  });

  it('names a documented key that arrives with the wrong kind of value', () => {
    // The reviewer's scenario: a hand-edited backup whose `fields` is an
    // object. Every reader below is tolerant — `listAt` answers a non-list
    // with `[]` — so until the shape check existed this migrated as an empty
    // configuration with an empty report, and the user was asked to confirm
    // a replacement the report said was empty.
    const outcome = analyse({ ...backup(), fields: { '0': field('email', { type: 'email' }) } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules).toEqual([]);
    const shape = outcome.plan.dropped.find((drop) => drop.code === 'migrateDroppedShape');
    expect(shape?.params).toEqual(['fields']);
  });

  it('names keyword lists that arrive as a bare string, and keeps this default rather than guessing theirs', () => {
    // The reference's UI parses a CSV box into the array; a hand-edited
    // backup may carry the unparsed string. Parsing it would be a guess the
    // documented schema never made, so the default stands — named, rather
    // than silently replacing whatever the user thought they had set.
    // `toEqual`, not `toBe`: the words stand, the array is the plan's own.
    const outcome = analyse({ ...backup(), agreeTermsFields: 'agree,terms' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.consentKeywords).toEqual(DEFAULT_SETTINGS.behaviour.consentKeywords);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'agreeTermsFields')).toBe(true);
  });

  it('names a mistyped password section, and stays silent about the mode it cannot read', () => {
    // A string passwordSettings has no mode to read, so neither the
    // defined-mode drop nor the random-mode note is owed — only the shape.
    const outcome = analyse({ ...backup(), passwordSettings: 'hunter2' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.passwords).toEqual(DEFAULT_SETTINGS.passwords);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedPasswordDefined')).toBe(false);
    expect(outcome.plan.noted.some((note) => note.code === 'migrateNotedPasswordRandom')).toBe(false);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'passwordSettings')).toBe(true);
  });

  it('names a mistyped switch and keeps the default rather than the string’s truthiness', () => {
    const outcome = analyse({ ...backup(), triggerClickEvents: 'no' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.behaviour.dispatchEvents).toBe(DEFAULT_SETTINGS.behaviour.dispatchEvents);
    expect(outcome.plan.dropped.some((drop) => drop.code === 'migrateDroppedShape' && drop.params[0] === 'triggerClickEvents')).toBe(true);
  });
});

describe('the plan itself', () => {
  it('replaces: nothing of the running configuration survives (BR-027-1)', () => {
    const outcome = analyse(backup({ fields: [field('phone', { type: 'telephone' })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules.map((rule) => rule.label)).toEqual(['phone']);
    expect(outcome.plan.current).toEqual({ rules: 1, profiles: 0 });
    expect(outcome.plan.incoming).toEqual({ rules: 1, profiles: 0 });
  });

  it('a well-shaped backup produces an empty drop list', () => {
    // The positive half of the shape check, so it cannot become a tax on
    // every honest backup: every key of every kind the table names — list,
    // object, number, boolean — translated with nothing reported dropped.
    // (Notes are a different promise: this fixture still earns a urlMatch
    // note and a cap note, and asserting those away would be testing the
    // wrong list.)
    const outcome = analyse({
      version: 1,
      fields: [field('phone', { type: 'telephone' })],
      profiles: [{ name: 'Staging', urlMatch: 'staging', fields: [] }],
      fieldMatchSettings: { matchName: true },
      ignoredFields: ['captcha'],
      agreeTermsFields: ['agree'],
      confirmFields: ['repeat'],
      defaultMaxLength: 20,
      enableContextMenu: true,
      ignoreFieldsWithContent: false,
      ignoreHiddenFields: true,
      passwordSettings: { mode: 'random', password: '' },
      triggerClickEvents: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.dropped).toEqual([]);
  });

  it('produces a state the parser reads back unchanged', () => {
    // The plan is what the user confirms; storage will normalise it, and a
    // normalisation that *changed* anything would mean the plan the user
    // agreed to is not the state they were given.
    const outcome = analyse(
      backup({
        fields: [
          field('phone', { type: 'telephone' }),
          field('when', { type: 'date', template: 'DD/MM/YYYY' }),
          field('serial', { type: 'alphanumeric', template: 'LLL-xxx' }),
        ],
        profiles: [{ name: 'Staging', urlMatch: 'staging', fields: [field('inner')] }],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(parseSettings(outcome.plan.settings)).toEqual(outcome.plan.settings);
  });

  it('mints ids unique within each list', () => {
    const outcome = analyse(
      backup({
        fields: [field('a'), field('b')],
        profiles: [
          { name: 'One', urlMatch: 'one', fields: [field('x')] },
          { name: 'Two', urlMatch: 'two', fields: [field('y')] },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const globalIds = outcome.plan.settings.rules.map((rule) => rule.id);
    expect(new Set(globalIds).size).toBe(globalIds.length);
    for (const profile of outcome.plan.settings.profiles) {
      const ids = profile.rules.map((rule) => rule.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => !globalIds.includes(id))).toBe(true);
    }
  });

  it('flags the version preamble only when the stated version is not the documented one (A2)', () => {
    const silent = analyse(backup());
    const stated = analyse({ ...backup(), version: 2 });
    const absent = analyse({ ...backup(), version: undefined });

    expect(silent.ok && silent.plan.versionStated && silent.plan.sourceVersion === 1).toBe(true);
    expect(stated.ok && stated.plan.sourceVersion).toBe(2);
    expect(absent.ok && !absent.plan.versionStated).toBe(true);
    expect(absent.ok && absent.plan.sourceVersion).toBeUndefined();
  });

  it('flags the persona sentence only when a persona-backed rule arrives (BR-027-6)', () => {
    const withPersona = analyse(backup({ fields: [field('mail', { type: 'email' })] }));
    const without = analyse(backup({ fields: [field('serial', { type: 'alphanumeric', template: 'xxx' })] }));

    expect(withPersona.ok && withPersona.plan.personaBacked).toBe(true);
    expect(without.ok && !without.plan.personaBacked).toBe(true);
  });

  it('flags the persona sentence when the only persona-backed rules are in profiles (BR-027-6)', () => {
    // A staging profile with username and email fields is a plausible shape,
    // and those rules draw from the fill's person exactly as global ones do
    // — the one sentence the report says about that change is owed for them.
    // Found in review: `personaBacked` read the global list only.
    const outcome = analyse(
      backup({
        fields: [field('serial', { type: 'alphanumeric', template: 'xxx' })],
        profiles: [
          { name: 'Staging', urlMatch: 'staging', fields: [field('user', { type: 'username' })] },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.personaBacked).toBe(true);
  });

  it('sets persona drawing on for the rules that can use it', () => {
    const outcome = analyse(backup({ fields: [field('mail', { type: 'email' })] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.settings.rules[0]?.fromPersona).toBe(true);
  });
});

describe('the two surfaces agree about what a Fake Filler backup is', () => {
  it('refuses the same file in the importer, pointing at the migration', () => {
    const file = backup({ fields: [field('mail', { type: 'email' })] });

    const imported = analyseImport(JSON.stringify(file), current());
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.refusal.code).toBe('importRefusedFakeFiller');
  });
});
