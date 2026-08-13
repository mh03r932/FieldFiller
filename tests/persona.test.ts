import { describe, expect, it } from 'vitest';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { generateValue } from '@/lib/generators/default-generator';
import type { FieldDescriptor } from '@/lib/protocol';

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

  it('keeps postcode, locality and region in the same place', () => {
    // BR-004-2. Checked against the known-good pairings rather than a format,
    // because a plausible-looking postcode from the wrong town is exactly the
    // incoherence this design exists to remove.
    const pairs = new Map([
      ['Bristol', 'BS1 4DJ'],
      ['Aberdeen', 'AB10 1XG'],
      ['Swansea', 'SA1 3RD'],
    ]);
    for (let seed = 0; seed < 50; seed++) {
      const persona = createPersona(seededRandom(seed));
      expect(persona.postalCode).toBe(pairs.get(persona.locality));
    }
  });

  it('can reach every entry of its corpus', () => {
    // D7: the reference indexes with `random() * (length - 1)`, so the last
    // entry of every array is unreachable — a bug invisible without this test.
    const seen = new Set<string>();
    for (let seed = 0; seed < 400; seed++) seen.add(createPersona(seededRandom(seed)).firstName);
    expect(seen.size).toBe(8);
  });
});

describe('default generator', () => {
  const persona = createPersona(seededRandom(3));
  const random = seededRandom(3);

  it('prefers the autocomplete purpose over the control kind', () => {
    const value = generateValue(descriptor({ kind: 'text', autocomplete: 'family-name' }), persona, random);
    expect(value.value).toBe(persona.lastName);
    expect(value.provenance).toContain('autocomplete');
  });

  it('falls back to the control kind when no purpose is declared', () => {
    const value = generateValue(descriptor({ kind: 'email' }), persona, random);
    expect(value.value).toBe(persona.email);
  });

  it('honours maxLength', () => {
    // D4: the reference computes an effective maxLength and then discards it,
    // passing a word count as the character cap.
    const value = generateValue(
      descriptor({ kind: 'text', constraints: { maxLength: 5 } }),
      persona,
      random,
    );
    expect(value.value.length).toBeLessThanOrEqual(5);
  });

  it('honours minLength', () => {
    const value = generateValue(
      descriptor({ kind: 'text', autocomplete: 'given-name', constraints: { minLength: 40 } }),
      persona,
      random,
    );
    expect(value.value.length).toBeGreaterThanOrEqual(40);
  });

  it('generates a password a registration form would accept', () => {
    // ND-11: the reference produces eight lowercase letters — no digit, no
    // uppercase, no symbol — and so fails the forms the feature exists to fill.
    const value = generateValue(descriptor({ kind: 'password' }), persona, random).value;
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[^A-Za-z0-9]/);
    expect(value.length).toBeGreaterThanOrEqual(12);
  });

  it('gives a textarea more than a single short phrase', () => {
    // ND-10: one global 20-character default means an unconstrained textarea
    // receives 20 characters, which is the reference's documented behaviour.
    const value = generateValue(descriptor({ kind: 'textarea' }), persona, random).value;
    expect(value.length).toBeGreaterThan(20);
  });

  it('always states where the value came from', () => {
    // FR-069. A mis-fill nobody can explain is the defect ND-2 identifies.
    for (const kind of ['text', 'email', 'tel', 'url', 'password', 'textarea'] as const) {
      expect(generateValue(descriptor({ kind }), persona, random).provenance).not.toBe('');
    }
  });
});
