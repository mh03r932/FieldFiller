import { describe, expect, it } from 'vitest';
import { corpusFor, createPersona, LOCALES, seededRandom } from '@/lib/persona/persona';
import { generateValue } from '@/lib/generators/default-generator';
import type { FieldDescriptor, FieldValue } from '@/lib/protocol';

/** Narrows to the text case, so a wrong-shaped value fails loudly rather than as undefined. */
function textOf(value: FieldValue): string {
  if (value.as !== 'text') throw new Error(`expected a text value, got "${value.as}"`);
  return value.value;
}

function descriptor(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { ref: 0, kind: 'text', sources: {}, constraints: {}, ...overrides };
}

describe('persona', () => {
  it('is identical for a given seed', () => {
    // BR-004-14: randomness is a runtime default, not a property of the design.
    // Without this the engine's output cannot be asserted at all, which is a
    // large part of why the reference has no tests.
    expect(createPersona(seededRandom(42))).toEqual(createPersona(seededRandom(42)));
  });

  it('differs between seeds', () => {
    expect(createPersona(seededRandom(1))).not.toEqual(createPersona(seededRandom(2)));
  });

  it('derives the email from the name rather than generating it separately', () => {
    // ND-1's whole point: coherence is a property of the record, not a
    // correlation between generators that ran at different times.
    const persona = createPersona(seededRandom(7));
    expect(persona.email.startsWith(persona.firstName.toLowerCase())).toBe(true);
    expect(persona.email).toContain(persona.lastName.toLowerCase());
    expect(persona.fullName).toBe(`${persona.firstName} ${persona.lastName}`);
  });

  it.each(LOCALES)('keeps postal code, locality and region together in %s', (locale) => {
    // BR-004-2. Checked against the corpus's own table rather than a format,
    // because a plausible-looking postal code from the wrong town is exactly the
    // incoherence this design exists to remove — and a format check would pass
    // on a Zürich address carrying a Genève PLZ.
    const corpus = corpusFor(locale);
    for (let seed = 0; seed < 200; seed++) {
      const persona = createPersona(seededRandom(seed), locale);
      const place = corpus.places.find(
        (candidate) =>
          candidate.locality === persona.locality && candidate.regionCode === persona.regionCode,
      );
      expect(place, `${persona.locality} / ${persona.regionCode} is not a place in ${locale}`).toBeDefined();
      expect(persona.postalCode.startsWith(place!.postalPrefix)).toBe(true);
      expect(persona.region).toBe(place!.region);
    }
  });

  it.each(LOCALES)('reaches the last entry of every list in %s', (locale) => {
    // D7: the reference indexes with `random() * (length - 1)`, so the last
    // entry of every array is unreachable — a bug that hid in plain sight on an
    // eight-name corpus and would hide far better on this one. Asserted against
    // the *specific* last entries rather than a count, because a count can be
    // reached while the final element never is.
    const corpus = corpusFor(locale);
    const lastFirstName = corpus.firstNames.at(-1);
    const lastPlace = corpus.places.at(-1);

    const firstNames = new Set<string>();
    const localities = new Set<string>();
    for (let seed = 0; seed < 6000; seed++) {
      const persona = createPersona(seededRandom(seed), locale);
      firstNames.add(persona.firstName);
      localities.add(persona.locality);
    }

    expect(firstNames.has(lastFirstName!)).toBe(true);
    expect(localities.has(lastPlace!.locality)).toBe(true);
  });

  it.each(LOCALES)('draws from enough of %s to stop repeating', (locale) => {
    // The complaint the corpus exists to answer: the placeholder repeated on the
    // ninth fill. A hundred consecutive fills should produce close to a hundred
    // different people.
    const seen = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const persona = createPersona(seededRandom(seed), locale);
      seen.add(`${persona.fullName}|${persona.locality}`);
    }
    expect(seen.size).toBeGreaterThan(95);
  });

  it('gives each locale its own country and phone format', () => {
    const american = createPersona(seededRandom(11), 'en-US');
    const swiss = createPersona(seededRandom(11), 'de-CH');

    expect(american.countryCode).toBe('US');
    expect(american.phone.startsWith('+1 ')).toBe(true);
    expect(swiss.countryCode).toBe('CH');
    expect(swiss.phone.startsWith('+41 ')).toBe(true);
    // Same seed, different corpus — so the locale is doing the work, not the seed.
    expect(american.locality).not.toBe(swiss.locality);
  });

  it('emits a Swiss AHV number whose check digit is right', () => {
    // Verified by an independent implementation of the EAN-13 rule. Checking the
    // generator's arithmetic with the generator's own arithmetic would prove
    // only that it agrees with itself, and a number that fails a Swiss form's
    // validation is worthless as test data — which is the only reason to emit
    // one at all.
    for (let seed = 0; seed < 200; seed++) {
      const { nationalId } = createPersona(seededRandom(seed), 'de-CH');
      expect(nationalId).toMatch(/^756\.\d{4}\.\d{4}\.\d{2}$/);

      const stripped = nationalId.replace(/\./g, '');
      const body = stripped.slice(0, 12);
      const stated = Number(stripped.slice(12));
      // Independent: sum the odd positions, treble the even ones, complete to ten.
      let sum = 0;
      for (const [index, character] of [...body].entries()) {
        sum += Number(character) * (index % 2 === 0 ? 1 : 3);
      }
      expect(stated).toBe((10 - (sum % 10)) % 10);
    }
  });

  it('emits a Swiss IBAN that passes the mod-97 check', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { iban } = createPersona(seededRandom(seed), 'de-CH');
      expect(iban).toMatch(/^CH\d{2}( \d{4}){4} \d$/);

      // ISO 13616 verbatim: move the first four characters to the end, expand
      // letters to numbers, and the whole value mod 97 must be 1.
      const compact = iban.replace(/ /g, '');
      const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
      const expanded = [...rearranged]
        .map((character) => (/[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character))
        .join('');
      let remainder = 0;
      for (const character of expanded) remainder = (remainder * 10 + Number(character)) % 97;
      expect(remainder).toBe(1);
    }
  });

  it('emits no national identifier where the locale has none', () => {
    // A US Social Security number carries no checksum, so a generated one is
    // indistinguishable from a real one. The slot is empty rather than filled
    // with something plausible.
    const american = createPersona(seededRandom(5), 'en-US');
    expect(american.nationalId).toBe('');
    expect(american.iban).toBe('');
  });

  it('gives an adult a date of birth a form would accept', () => {
    for (let seed = 0; seed < 100; seed++) {
      const { dateOfBirth } = createPersona(seededRandom(seed), 'de-CH');
      expect(dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const age = new Date().getUTCFullYear() - Number(dateOfBirth.slice(0, 4));
      expect(age).toBeGreaterThanOrEqual(18);
      expect(age).toBeLessThanOrEqual(80);
    }
  });
});

describe('default generator', () => {
  const persona = createPersona(seededRandom(3));
  const random = seededRandom(3);

  it('prefers the autocomplete purpose over the control kind', () => {
    const value = generateValue(descriptor({ kind: 'text', autocomplete: 'family-name' }), persona, random);
    expect(textOf(value)).toBe(persona.lastName);
    expect(value.provenance).toContain('autocomplete');
  });

  it('falls back to the control kind when no purpose is declared', () => {
    const value = generateValue(descriptor({ kind: 'email' }), persona, random);
    expect(textOf(value)).toBe(persona.email);
  });

  it('honours maxLength', () => {
    // D4: the reference computes an effective maxLength and then discards it,
    // passing a word count as the character cap.
    const value = generateValue(
      descriptor({ kind: 'text', constraints: { maxLength: 5 } }),
      persona,
      random,
    );
    expect(textOf(value).length).toBeLessThanOrEqual(5);
  });

  it('keeps a password valid when maxLength forces it shorter', () => {
    // Plain slicing takes the tail off, where the symbol and the digits sit — so
    // a constrained field would receive a value failing exactly the policy
    // ND-11 exists to satisfy: shortened, and useless.
    for (const maxLength of [8, 10, 12]) {
      const password = textOf(
        generateValue(descriptor({ kind: 'password', constraints: { maxLength } }), persona, random),
      );
      expect(password.length).toBeLessThanOrEqual(maxLength);
      expect(password, `maxLength ${maxLength}`).toMatch(/[a-z]/);
      expect(password, `maxLength ${maxLength}`).toMatch(/[A-Z]/);
      expect(password, `maxLength ${maxLength}`).toMatch(/[0-9]/);
      expect(password, `maxLength ${maxLength}`).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('keeps a shortened password equal to its confirmation field', () => {
    // UC-006 has to survive the shortening: both fields carry the same ceiling,
    // so both must arrive at the same value.
    const constraints = { maxLength: 10 };
    expect(
      textOf(generateValue(descriptor({ kind: 'password', sources: { name: 'pw' }, constraints }), persona, random)),
    ).toBe(
      textOf(
        generateValue(
          descriptor({ kind: 'password', sources: { name: 'confirm_pw' }, constraints }),
          persona,
          random,
        ),
      ),
    );
  });

  it('does not produce NaN from a non-numeric min or max', () => {
    // Constraints are attribute strings, so they hold whatever the page wrote.
    const value = textOf(
      generateValue(descriptor({ kind: 'number', constraints: { min: 'abc', max: 'xyz' } }), persona, random),
    );
    expect(value).not.toContain('NaN');
    expect(Number.isFinite(Number(value))).toBe(true);
  });

  it('honours minLength', () => {
    const value = generateValue(
      descriptor({ kind: 'text', autocomplete: 'given-name', constraints: { minLength: 40 } }),
      persona,
      random,
    );
    expect(textOf(value).length).toBeGreaterThanOrEqual(40);
  });

  it('generates a password a registration form would accept', () => {
    // ND-11: the reference produces eight lowercase letters — no digit, no
    // uppercase, no symbol — and so fails the forms the feature exists to fill.
    const value = textOf(generateValue(descriptor({ kind: 'password' }), persona, random));
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[^A-Za-z0-9]/);
    expect(value.length).toBeGreaterThanOrEqual(12);
  });

  it('gives a textarea more than a single short phrase', () => {
    // ND-10: one global 20-character default means an unconstrained textarea
    // receives 20 characters, which is the reference's documented behaviour.
    const value = textOf(generateValue(descriptor({ kind: 'textarea' }), persona, random));
    expect(value.length).toBeGreaterThan(20);
  });

  it('always states where the value came from', () => {
    // FR-069. A mis-fill nobody can explain is the defect ND-2 identifies.
    for (const kind of ['text', 'email', 'tel', 'url', 'password', 'textarea'] as const) {
      expect(generateValue(descriptor({ kind }), persona, random).provenance).not.toBe('');
    }
  });
});
