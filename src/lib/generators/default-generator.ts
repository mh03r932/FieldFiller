import type { FieldDescriptor, FieldValue } from '../protocol';
import type { Persona, Random } from '../persona/persona';

/**
 * Chooses a value for one descriptor (UC-004 steps 5–7).
 *
 * Phase 1 has no rule matching, so this is only the default path: the
 * `autocomplete` purpose if the page declares one, otherwise the control's kind.
 * Phase 2 puts the user's ordered rules in front of it, first-match-wins
 * (BR-004-4), and this becomes the fallback it already is.
 *
 * Every persona-derived value comes from the one record passed in, so the fields
 * agree by construction (BR-004-1).
 *
 * Background-only: the corpus and the generators never enter the page agent
 * (DD-003, ND-4).
 */

/**
 * `autocomplete` purpose → persona attribute.
 *
 * A better identity signal than any regex on `id`, and one the reference ignores
 * entirely (§7.3, upstream issue #188). Where a page has bothered to declare
 * what a field is for, guessing instead is indefensible.
 */
const AUTOCOMPLETE_ATTRIBUTES: Record<string, keyof Persona> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  nickname: 'username',
  username: 'username',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'organisation',
  'street-address': 'streetAddress',
  'address-line1': 'streetAddress',
  'address-level2': 'locality',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  url: 'url',
};

/** Control kind → persona attribute, for fields that declare no purpose. */
const KIND_ATTRIBUTES: Partial<Record<FieldDescriptor['kind'], keyof Persona>> = {
  email: 'email',
  tel: 'phone',
  url: 'url',
};

const LOREM = [
  'consectetur adipiscing elit',
  'sed do eiusmod tempor',
  'ut enim ad minim veniam',
  'quis nostrud exercitation',
];

export function generateValue(
  descriptor: FieldDescriptor,
  persona: Persona,
  random: Random,
): FieldValue {
  const { value, provenance } = select(descriptor, persona, random);

  return {
    ref: descriptor.ref,
    // BR-004-7: the control's own constraints are a ceiling. A value the page's
    // own validation would reject is a defect, not a choice — and the reference
    // computes an effective maxLength and then discards it (D4).
    value: constrain(value, descriptor),
    provenance,
  };
}

function select(
  descriptor: FieldDescriptor,
  persona: Persona,
  random: Random,
): { value: string; provenance: string } {
  const purpose = descriptor.autocomplete;
  if (purpose !== undefined) {
    const attribute = AUTOCOMPLETE_ATTRIBUTES[purpose];
    if (attribute !== undefined) {
      return { value: persona[attribute], provenance: `autocomplete="${purpose}" → persona.${attribute}` };
    }
  }

  const byKind = KIND_ATTRIBUTES[descriptor.kind];
  if (byKind !== undefined) {
    return { value: persona[byKind], provenance: `kind "${descriptor.kind}" → persona.${byKind}` };
  }

  if (descriptor.kind === 'password') {
    return { value: password(random), provenance: 'kind "password" → generated' };
  }

  // UC-004 A2: no meaningful default for this kind, so a short neutral value
  // sized for it. A textarea gets a paragraph rather than the reference's
  // 20 characters, which is ND-10's papercut.
  const sentences = descriptor.kind === 'textarea' ? 3 : 1;
  const value = Array.from({ length: sentences }, () => pick(LOREM, random)).join(', ');
  return { value: `Lorem ipsum ${value}`, provenance: `kind "${descriptor.kind}" → neutral text` };
}

/**
 * A password that would actually pass a registration form.
 *
 * The reference's is eight lowercase letters — no digit, no uppercase, no
 * symbol — which fails the very forms the feature exists to fill (ND-11).
 * Phase 2 reads `pattern` and `minlength` off the field; this at least clears
 * the common policy.
 */
function password(random: Random): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const from = (set: string, count: number) =>
    Array.from({ length: count }, () => set[Math.floor(random() * set.length)]).join('');

  return `${from(upper, 1)}${from(lower, 8)}${from(digits, 3)}${from(symbols, 1)}`;
}

function constrain(value: string, descriptor: FieldDescriptor): string {
  const { maxLength, minLength } = descriptor.constraints;
  let result = value;

  if (minLength !== undefined && result.length < minLength) {
    result = result.padEnd(minLength, 'x');
  }
  if (maxLength !== undefined && result.length > maxLength) {
    result = result.slice(0, maxLength);
  }
  return result;
}

function pick<T>(items: readonly T[], random: Random): T {
  return items[Math.floor(random() * items.length)] as T;
}
