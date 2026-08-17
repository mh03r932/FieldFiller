import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import {
  constrain,
  generateValue,
  mirrorsAnotherField,
  type BehaviourDefaults,
} from '@/lib/generators/default-generator';
import { generateBatch } from '@/lib/generators/batch';
import {
  DEFAULT_CONFIRMATION_KEYWORDS,
  DEFAULT_CONSENT_KEYWORDS,
  DEFAULT_PASSWORD_POLICY,
  parseSettings,
  type PasswordPolicy,
} from '@/lib/settings';
import type { FieldDescriptor } from '@/lib/protocol';

/**
 * The three settings Phase 4 made reachable, tested where they take effect.
 *
 * All three — the password policy, the per-kind length caps and the two keyword
 * lists — existed in the schema before the screens that author them, and none of
 * them was read by anything. A stored setting nothing consumes is worse than a
 * missing one: the screen reports it saved, the fill ignores it, and there is
 * nothing on either surface to say which is lying. These are the assertions that
 * make the screens honest, so they are written against the generator rather than
 * against the options page.
 */

/**
 * The one fillable control in a fragment, found the way a fill finds it.
 *
 * Through `collectCandidates` rather than `firstElementChild`, because half the
 * fragments here wrap the control in its own `<label>` — which is the point of
 * them: a keyword in the label text is exactly the case D2 says the reference
 * misses by testing `element.name` alone.
 */
function only(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return collectCandidates(host)[0]!;
}

function descriptorFor(html: string): FieldDescriptor {
  const element = only(html);
  const classification = classifyStructural(element, {
    skipHidden: false,
    skipPreFilled: false,
    writtenByUs: new WeakSet<Element>(),
  });
  if (!classification.fillable) throw new Error(`excluded: ${classification.reason}`);
  return describeField(element, 0, classification.kind);
}

const defaults = (overrides: Partial<BehaviourDefaults> = {}): BehaviourDefaults => ({
  consentKeywords: DEFAULT_CONSENT_KEYWORDS,
  confirmationKeywords: DEFAULT_CONFIRMATION_KEYWORDS,
  maxLengths: {},
  ...overrides,
});

/** The password for one policy, drawn the way a fill draws it. */
function passwordFor(policy: PasswordPolicy, seed = 7): string {
  return createPersona(seededRandom(seed), 'en-US', policy).password;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the password policy reaches generation (FR-025, UC-019)', () => {
  it('produces a password of the configured length', () => {
    for (const length of [8, 16, 32, 64]) {
      expect(passwordFor({ ...DEFAULT_PASSWORD_POLICY, length })).toHaveLength(length);
    }
  });

  it('includes one of every class that is ticked', () => {
    const password = passwordFor(DEFAULT_PASSWORD_POLICY);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it('omits every class that is unticked', () => {
    // The half worth asserting. A policy that only ever *adds* is satisfied by
    // ignoring it, and a user who switched symbols off because the form rejects
    // them would find out on the form.
    const password = passwordFor({
      length: 20,
      upper: false,
      lower: true,
      digits: true,
      symbols: false,
    });
    expect(password).toMatch(/^[a-z0-9]+$/);
    expect(password).toHaveLength(20);
  });

  it('falls back to lowercase when nothing at all is ticked', () => {
    // A password drawn from no character class is the empty string, which would
    // fill the field with nothing and report it filled. UC-019 A1 says so on the
    // screen rather than leaving the sample to be puzzled over.
    const password = passwordFor({
      length: 12,
      upper: false,
      lower: false,
      digits: false,
      symbols: false,
    });
    expect(password).toMatch(/^[a-z]+$/);
    expect(password).toHaveLength(12);
  });

  it('lets length win over composition when the two cannot both be met', () => {
    // Length is what the page checks (BR-019-2), so a three-character policy
    // demanding four classes comes out three characters long rather than four.
    expect(passwordFor({ ...DEFAULT_PASSWORD_POLICY, length: 3 })).toHaveLength(3);
  });

  it('gives the same password to a field and its confirmation', () => {
    // The policy is applied once per persona rather than per field, which is
    // what keeps UC-006 true: a per-field policy would generate two passwords.
    const persona = createPersona(seededRandom(3), 'en-US', DEFAULT_PASSWORD_POLICY);
    const random = seededRandom(3);
    const first = generateValue(descriptorFor('<input type="password" name="pw">'), persona, random);
    const second = generateValue(
      descriptorFor('<input type="password" name="confirm_pw">'),
      persona,
      random,
    );
    expect(first).toHaveProperty('value');
    expect(second).toHaveProperty('value');
    expect((first as { value: string }).value).toBe((second as { value: string }).value);
  });

  it('does not put back a class the policy switched off when a maxlength bites', () => {
    // The fitter used to default each missing class to a literal — `'A'`, `'7'`,
    // `'!'` — which was harmless while every password came from one recipe and
    // became wrong the moment the policy was configurable. The fields likeliest
    // to carry a `maxlength` are also the likeliest to restrict the character
    // set, so this is where handing back a symbol costs the most.
    const lettersOnly = passwordFor({
      length: 24,
      upper: false,
      lower: true,
      digits: false,
      symbols: false,
    });
    const fitted = constrain(lettersOnly, descriptorFor('<input type="password" maxlength="10">'));
    expect(fitted).toHaveLength(10);
    expect(fitted).toMatch(/^[a-z]+$/);
  });

  it('keeps one of each class it does have when shortening', () => {
    const fitted = constrain(
      passwordFor(DEFAULT_PASSWORD_POLICY),
      descriptorFor('<input type="password" maxlength="8">'),
    );
    expect(fitted).toHaveLength(8);
    expect(fitted).toMatch(/[A-Z]/);
    expect(fitted).toMatch(/[a-z]/);
    expect(fitted).toMatch(/[0-9]/);
    expect(fitted).toMatch(/[^A-Za-z0-9]/);
  });
});

describe('per-kind length caps (FR-065, UC-022)', () => {
  it('caps a control of that kind which declares no maxlength', () => {
    const value = generateValue(
      descriptorFor('<textarea></textarea>'),
      createPersona(seededRandom(5)),
      seededRandom(5),
      defaults({ maxLengths: { textarea: 12 } }),
    );
    expect((value as { value: string }).value).toHaveLength(12);
  });

  it('loses to the control\'s own maxlength', () => {
    // ND-11 arriving through the settings screen is still ND-11. A configured
    // cap that overrode the page would produce values the form rejects.
    const value = generateValue(
      descriptorFor('<textarea maxlength="5"></textarea>'),
      createPersona(seededRandom(5)),
      seededRandom(5),
      defaults({ maxLengths: { textarea: 40 } }),
    );
    expect((value as { value: string }).value).toHaveLength(5);
  });

  it('applies to the configured kind and no other', () => {
    const value = generateValue(
      descriptorFor('<input type="text" name="notes">'),
      createPersona(seededRandom(5)),
      seededRandom(5),
      defaults({ maxLengths: { textarea: 4 } }),
    );
    expect((value as { value: string }).value.length).toBeGreaterThan(4);
  });

  it('leaves lengths alone when nothing is configured, which is the default', () => {
    const uncapped = generateValue(
      descriptorFor('<textarea></textarea>'),
      createPersona(seededRandom(5)),
      seededRandom(5),
    );
    // ND-10's papercut: the reference gives an unconstrained textarea twenty
    // characters. A paragraph is what it should get.
    expect((uncapped as { value: string }).value.length).toBeGreaterThan(20);
  });
});

describe('consent keywords (FR-015, UC-022)', () => {
  const tick = (html: string, keywords: readonly string[]): boolean => {
    const value = generateValue(
      descriptorFor(html),
      createPersona(seededRandom(1)),
      // Pinned so an unticked box is a decision rather than a coin flip: this
      // seed's first draw is above 0.5, so anything ticked here was ticked for
      // a reason.
      () => 0.9,
      defaults({ consentKeywords: keywords }),
    );
    return (value as { checked: boolean }).checked;
  };

  it('ticks a box matching a configured keyword', () => {
    expect(tick('<label>Ich stimme zu<input type="checkbox" name="agb"></label>', ['stimme zu']))
      .toBe(true);
  });

  it('stops ticking a box once its keyword is removed', () => {
    expect(tick('<label>Accept terms<input type="checkbox" name="tos"></label>', ['gdpr']))
      .toBe(false);
  });

  it('ticks nothing for consent when the list is emptied', () => {
    // An empty alternation would compile to `//`, which matches everything —
    // so emptying the list would tick every checkbox on the page rather than
    // none. The opposite of what emptying it asks for.
    expect(tick('<label>Accept terms<input type="checkbox" name="tos"></label>', []))
      .toBe(false);
  });

  it('still ticks a required box with no keywords at all', () => {
    // Not configurable, and deliberately: an unticked required box blocks the
    // submission the fill exists to reach.
    expect(tick('<input type="checkbox" name="tos" required>', [])).toBe(true);
  });

  it('treats a keyword as a literal, not as a pattern', () => {
    // Escaped before compiling, so a user typing regex syntax gets a keyword
    // rather than a syntax error or an accidental wildcard.
    expect(tick('<input type="checkbox" name="c++licence">', ['c++'])).toBe(true);
    expect(tick('<input type="checkbox" name="cccclicence">', ['c++'])).toBe(false);
  });
});

describe('confirmation keywords (FR-024, UC-022)', () => {
  it('mirrors a field matching a configured keyword', () => {
    expect(
      mirrorsAnotherField(
        descriptorFor('<input type="password" name="passwort_wiederholen">'),
        defaults({ confirmationKeywords: ['wiederholen'] }),
      ),
    ).toBe(true);
  });

  it('stops mirroring once the keyword is removed', () => {
    expect(
      mirrorsAnotherField(
        descriptorFor('<input type="password" name="confirm_password">'),
        defaults({ confirmationKeywords: ['wiederholen'] }),
      ),
    ).toBe(false);
  });

  it('keeps the trailing ordinal whatever the keywords say', () => {
    // A convention about shape rather than a word, so it is not in the list and
    // cannot be deleted from it. UC-022 states the split, because a screen
    // offering "confirmation keywords" would otherwise be read as offering all
    // of it.
    expect(
      mirrorsAnotherField(
        descriptorFor('<input type="password" name="password2">'),
        defaults({ confirmationKeywords: [] }),
      ),
    ).toBe(true);
  });

  it('still refuses to treat a second address line as a repetition', () => {
    expect(
      mirrorsAnotherField(
        descriptorFor('<input name="address2">'),
        defaults({ confirmationKeywords: [] }),
      ),
    ).toBe(false);
  });

  it('carries the configured keywords through a whole batch', () => {
    // The path a real fill takes: the background captures the defaults once per
    // operation and every frame's batch is generated against them.
    const descriptors = [
      descriptorFor('<input type="email" name="email">'),
      descriptorFor('<input type="email" name="email_wiederholen">'),
    ];
    const { values } = generateBatch(descriptors, {
      persona: createPersona(seededRandom(2)),
      randomFor: () => seededRandom(2),
      defaults: defaults({ confirmationKeywords: ['wiederholen'] }),
    });
    expect((values[0] as { value: string }).value).toBe((values[1] as { value: string }).value);
  });
});

describe('the keyword lists survive storage (UC-022, UC-024)', () => {
  it('keeps an emptied list empty rather than restoring the shipped words', () => {
    // `strings`-style defaulting would make the screen's last removal silently
    // undo itself on the next load.
    const parsed = parseSettings({ behaviour: { consentKeywords: [] } });
    expect(parsed.behaviour.consentKeywords).toEqual([]);
  });

  it('falls back to the shipped words when the key is absent', () => {
    expect(parseSettings({ behaviour: {} }).behaviour.consentKeywords)
      .toEqual(DEFAULT_CONSENT_KEYWORDS);
  });

  it('drops blank entries, which would otherwise match every field', () => {
    // One stray empty line in the textarea is the edit that looks like nothing
    // on screen and ticks every checkbox on every page.
    const parsed = parseSettings({ behaviour: { consentKeywords: ['  ', 'agb', ' terms '] } });
    expect(parsed.behaviour.consentKeywords).toEqual(['agb', 'terms']);
  });

  it('keeps a per-kind cap and drops one that is not a positive integer', () => {
    const parsed = parseSettings({
      behaviour: { maxLengths: { textarea: 40, text: 0, search: 'lots' } },
    });
    expect(parsed.behaviour.maxLengths).toEqual({ textarea: 40 });
  });
});

describe('trigger settings (FR-050, UC-023)', () => {
  it('ships with the context menu on', () => {
    // Off would make two of the three scopes unreachable until the user found
    // the screen: the menu is the only channel with a cursor to narrow from.
    expect(parseSettings({}).triggers.contextMenu).toBe(true);
  });

  it('reads a stored choice back', () => {
    expect(parseSettings({ triggers: { contextMenu: false } }).triggers.contextMenu).toBe(false);
  });

  it('defaults rather than throwing on a malformed section', () => {
    for (const triggers of [null, 'off', 42, { contextMenu: 'no' }]) {
      expect(parseSettings({ triggers }).triggers.contextMenu).toBe(true);
    }
  });
});
