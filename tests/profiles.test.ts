import { describe, expect, it } from 'vitest';
import { activeProfile, matchesProfile, newProfile, profileName, rulesFor } from '@/lib/profiles';
import { appendAt, moveAt, removeAt, replaceAt } from '@/lib/lists';
import { compileRules } from '@/lib/rules/match';
import { generateBatch } from '@/lib/generators/batch';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { parseSettings, type Profile, type Rule } from '@/lib/settings';
import type { FieldDescriptor } from '@/lib/protocol';

function descriptorFor(html: string): FieldDescriptor {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const element = collectCandidates(host)[0]!;
  const classification = classifyStructural(element, {
    skipHidden: false,
    skipPreFilled: false,
    writtenByUs: new WeakSet<Element>(),
  });
  if (!classification.fillable) throw new Error(`excluded: ${classification.reason}`);
  return describeField(element, 0, classification.kind);
}

/**
 * Profile resolution and the list it is resolved from (UC-007, UC-014..UC-017).
 *
 * The whole of Phase 5's engine change is "which profile governs this page, and
 * what does that do to the rule order" — two pure questions, and both fail
 * *silently* when wrong: the wrong profile means the wrong rules ran, and the
 * fill still reports success on every field. Nothing on a filled page says which
 * rule produced a value that looks plausible either way.
 */

function profile(overrides: Partial<Profile> = {}): Profile {
  return { ...newProfile('p1'), label: 'One', urls: ['*.example.com/*'], ...overrides };
}

function rule(id: string): Rule {
  return {
    id,
    label: id,
    enabled: true,
    match: { mode: 'contains', pattern: 'field' },
    generator: { type: 'constant', value: id },
    fromPersona: true,
  };
}

describe('which profile governs a page (UC-017)', () => {
  it('matches a glob against the page address', () => {
    expect(matchesProfile(profile(), 'https://app.example.com/checkout')).toBe(true);
    expect(matchesProfile(profile(), 'https://example.net/checkout')).toBe(false);
  });

  it('matches when any one of several patterns does', () => {
    const many = profile({ urls: ['*.staging.test/*', 'localhost/*'] });
    expect(matchesProfile(many, 'http://localhost:3000/signup')).toBe(true);
  });

  it('matches nothing when it has no patterns', () => {
    // Both readings are defensible from an empty list, and the difference is a
    // profile's rules silently applying to every page the user visits. This is
    // the reading whose failure is visible — the profile never applies, and the
    // editor flags it while it is being written (UC-014 A2).
    expect(matchesProfile(profile({ urls: [] }), 'https://app.example.com/')).toBe(false);
    expect(activeProfile([profile({ urls: [] })], 'https://app.example.com/')).toBeUndefined();
  });

  it('ignores a blank pattern rather than treating it as a wildcard', () => {
    // A blank row is what a half-written profile looks like, and an empty glob
    // compared against a URL must not become "everything".
    expect(matchesProfile(profile({ urls: [''] }), 'https://anything.test/')).toBe(false);
  });

  it('takes the first match, so order is precedence', () => {
    const narrow = profile({ id: 'narrow', label: 'Narrow', urls: ['*.staging.example.com/*'] });
    const broad = profile({ id: 'broad', label: 'Broad', urls: ['*.example.com/*'] });

    expect(activeProfile([narrow, broad], 'https://a.staging.example.com/x')?.label).toBe('Narrow');
    // The same two profiles the other way round give the other answer, which is
    // the point: overlap is resolved by a position the user can see and move,
    // not by a specificity rule they would have to know (ND-2).
    expect(activeProfile([broad, narrow], 'https://a.staging.example.com/x')?.label).toBe('Broad');
  });

  it('skips a disabled profile so the next one gets its turn', () => {
    const off = profile({ id: 'off', label: 'Off', enabled: false });
    const on = profile({ id: 'on', label: 'On' });
    expect(activeProfile([off, on], 'https://app.example.com/')?.label).toBe('On');
  });

  it('returns nothing when no profile matches', () => {
    expect(activeProfile([profile()], 'https://unrelated.test/')).toBeUndefined();
    expect(activeProfile([], 'https://app.example.com/')).toBeUndefined();
  });

  it('ignores the port, as the exclusion list does', () => {
    // One glob matcher for both, so a pattern cannot mean different things in
    // the two places a user types one.
    expect(matchesProfile(profile({ urls: ['localhost/*'] }), 'http://localhost:5173/x')).toBe(true);
  });
});

describe('what to call a profile (FR-047, UC-014)', () => {
  it('uses the label when there is one', () => {
    expect(profileName(profile({ label: 'Acme staging' }))).toBe('Acme staging');
  });

  it('falls back to the first pattern for a profile not named yet', () => {
    // Worse to read than a name, and never blank — blank is what makes a list
    // unusable (BR-009-3's argument), and what made the report lie: `''` is
    // folded into "no profile matched this page" by `profileSentence`.
    expect(profileName(profile({ label: '', urls: ['', '*.example.com/*'] }))).toBe('*.example.com/*');
  });

  it('has no name for a profile with neither, which is a profile being written', () => {
    expect(profileName(newProfile('p1'))).toBeUndefined();
  });

  it('always names a profile that governs a page', () => {
    // The property the background relies on: `activeProfile` only returns a
    // profile that matched, and `matchesProfile` ignores empty patterns, so the
    // fallback above always has something to return. Asserted rather than
    // argued, because the background reports `undefined` as "no profile".
    const nameless = profile({ label: '', urls: ['', '*.example.com/*'] });
    const active = activeProfile([nameless], 'https://app.example.com/checkout');
    expect(active).toBeDefined();
    expect(profileName(active!)).toBe('*.example.com/*');
  });
});

describe('what a profile does to the rule order (UC-007, FR-031)', () => {
  const global = [rule('global-1'), rule('global-2')];

  it('puts the profile\'s rules ahead of the global list', () => {
    const scoped = profile({ rules: [rule('profile-1')] });
    expect(rulesFor(scoped, global).map((r) => r.id))
      .toEqual(['profile-1', 'global-1', 'global-2']);
  });

  it('keeps the global rules rather than replacing them', () => {
    // A profile is a set of additions for one application, not a mode.
    // Replacing would mean every profile had to restate the user's general
    // rules, and forgetting one would be invisible until a field came out wrong
    // on that application alone.
    const scoped = profile({ rules: [rule('profile-1')] });
    expect(rulesFor(scoped, global)).toHaveLength(3);
  });

  it('leaves the global list untouched when no profile applies', () => {
    expect(rulesFor(undefined, global)).toEqual(global);
  });

  it('is the global list alone for a profile with no rules of its own', () => {
    expect(rulesFor(profile({ rules: [] }), global).map((r) => r.id))
      .toEqual(['global-1', 'global-2']);
  });
});

/**
 * The whole chain a fill runs, minus the one link a browser cannot be made to
 * exercise.
 *
 * `activeTab` follows a real user gesture and cannot be synthesised, so a
 * harness-triggered fill reads no address and resolves no profile — the same
 * structural gap FR-037's pattern path has, and for the same reason. What can be
 * asserted is everything downstream of the address: resolution, precedence,
 * compilation and the value a control actually receives. That is the part where
 * a mistake is invisible, because a plausible value arrives either way.
 *
 * Composed here exactly as `startFill` composes it. The three lines in
 * `background.ts` that join these are the untested remainder, and they are
 * `activeProfile`, `rulesFor` and `compileRules` in that order.
 */
describe('a profile rule reaches the control, ahead of the global rule (UC-007)', () => {
  const settings = parseSettings({
    rules: [
      {
        id: 'g', label: 'Global', enabled: true,
        match: { mode: 'contains', pattern: 'code' },
        generator: { type: 'constant', value: 'GLOBAL' },
        fromPersona: true,
      },
    ],
    profiles: [
      {
        id: 'p', label: 'Staging', enabled: true, urls: ['*.staging.test/*'],
        rules: [
          {
            id: 'pr', label: 'Scoped', enabled: true,
            match: { mode: 'contains', pattern: 'code' },
            generator: { type: 'constant', value: 'SCOPED' },
            fromPersona: true,
          },
        ],
      },
    ],
  });

  const valueOn = (url: string | undefined): string => {
    const profile = url === undefined ? undefined : activeProfile(settings.profiles, url);
    const compiled = compileRules(rulesFor(profile, settings.rules), settings.sources);
    const { values } = generateBatch([descriptorFor('<input name="short_code">')], {
      persona: createPersona(seededRandom(1)),
      randomFor: () => seededRandom(1),
      rules: compiled,
    });
    return (values[0] as { value: string }).value;
  };

  it('uses the profile rule on a page the profile matches', () => {
    expect(valueOn('https://app.staging.test/checkout')).toBe('SCOPED');
  });

  it('uses the global rule on a page it does not', () => {
    expect(valueOn('https://app.production.test/checkout')).toBe('GLOBAL');
  });

  it('uses the global rule when the address could not be read', () => {
    // The safe direction, and the one a harness actually exercises. Refusing to
    // fill because the profile could not be determined would make every page
    // whose address we cannot read unfillable the moment a user created their
    // first profile.
    expect(valueOn(undefined)).toBe('GLOBAL');
  });
});

describe('the profile list survives storage (UC-024)', () => {
  it('round-trips a profile with rules and patterns', () => {
    const stored = { profiles: [profile({ rules: [rule('r1')] })] };
    const parsed = parseSettings(stored);
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]?.urls).toEqual(['*.example.com/*']);
    expect(parsed.profiles[0]?.rules.map((r) => r.id)).toEqual(['r1']);
  });

  it('keeps a profile whose rules are all invalid, rather than the profile vanishing', () => {
    // The parser drops a malformed *rule*; it must not take the profile with it,
    // or a user who mistyped one pattern loses the scoping and the other rules.
    const parsed = parseSettings({
      profiles: [{ id: 'p', label: 'P', enabled: true, urls: ['a/*'], rules: [{ nonsense: true }] }],
    });
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]?.rules).toEqual([]);
  });

  it('drops a profile with no id, which nothing could ever edit', () => {
    expect(parseSettings({ profiles: [{ label: 'no id' }] }).profiles).toEqual([]);
  });
});

describe('list operations (UC-014..UC-016)', () => {
  const a = profile({ id: 'a' });
  const b = profile({ id: 'b' });
  const c = profile({ id: 'c' });

  it('appends, so an existing profile keeps governing what it governed', () => {
    expect(appendAt([a], b).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('moves one place and stops at the ends rather than wrapping', () => {
    expect(moveAt([a, b, c], 1, -1).map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(moveAt([a, b, c], 2, 1).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(moveAt([a, b, c], 0, -1).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list alone for a position that is not in it', () => {
    expect(moveAt([a, b], 9, 1).map((p) => p.id)).toEqual(['a', 'b']);
    expect(removeAt([a, b], 9).map((p) => p.id)).toEqual(['a', 'b']);
    expect(replaceAt([a, b], 9, c).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('starts a new profile matching nothing and containing nothing', () => {
    // A profile that started at `*` would govern every tab from the moment it
    // was created, before the user had said which pages it was for.
    expect(newProfile('x')).toEqual({
      id: 'x', label: '', enabled: true, urls: [], rules: [],
    });
  });
});
