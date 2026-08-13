import type { ControlOption, FieldDescriptor, FieldValue } from '../protocol';
import type { Persona, Random } from '../persona/persona';

/**
 * Chooses a value for one descriptor (UC-004 steps 5–7).
 *
 * With no rules configured this is the whole path: the `autocomplete` purpose if
 * the page declares one, otherwise the control's kind. Phase 4's rules go in
 * front of it, first-match-wins (BR-004-4), and this becomes the fallback it
 * already is.
 *
 * Every persona-derived value comes from the one record passed in, so the fields
 * agree by construction (BR-004-1) — including confirmation fields, which
 * resolve to the same slot as the field they confirm rather than replaying a
 * previously generated value (ND-7, UC-006).
 *
 * Background-only: the corpus and the generators never enter the page agent
 * (DD-003, ND-4).
 */

/**
 * `autocomplete` purpose → persona attribute.
 *
 * A better identity signal than any regex on `id`, and one the reference ignores
 * entirely (§7.3, upstream issue #188).
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
  'new-password': 'password',
  'current-password': 'password',
};

/** Control kind → persona attribute, for fields that declare no purpose. */
const KIND_ATTRIBUTES: Partial<Record<FieldDescriptor['kind'], keyof Persona>> = {
  email: 'email',
  tel: 'phone',
  url: 'url',
  password: 'password',
};

/**
 * Words that mark a field as confirming another (UC-006, D2).
 *
 * Tested against every matching source, not just `element.name`. The reference
 * tests `name` alone, so a "Confirm password" field identified only by its `id`
 * or its `<label>` never mirrors the original — even though matching for
 * everything else uses all sources (D2).
 */
const CONFIRMATION_MARKERS = /confirm|verify|repeat|retype|again|_2$|2$/i;

/**
 * Identity words that suggest a persona attribute when no `autocomplete` is
 * declared. Ordered: the first match wins, so more specific entries come first.
 */
const IDENTITY_HINTS: ReadonlyArray<readonly [RegExp, keyof Persona]> = [
  [/first[\s_-]*name|given[\s_-]*name|forename/i, 'firstName'],
  [/last[\s_-]*name|family[\s_-]*name|surname/i, 'lastName'],
  [/full[\s_-]*name|^name$|your[\s_-]*name/i, 'fullName'],
  [/e-?mail/i, 'email'],
  [/pass(word|phrase)/i, 'password'],
  [/user[\s_-]*name|login|handle/i, 'username'],
  [/phone|mobile|telephone/i, 'phone'],
  [/post(al)?[\s_-]*code|zip/i, 'postalCode'],
  [/address|street/i, 'streetAddress'],
  [/city|town|locality/i, 'locality'],
  [/state|province|region|county/i, 'region'],
  [/country/i, 'country'],
  [/company|organisation|organization|employer/i, 'organisation'],
  [/web[\s_-]*site|homepage|url/i, 'url'],
];

const LOREM = [
  'consectetur adipiscing elit',
  'sed do eiusmod tempor incididunt',
  'ut enim ad minim veniam',
  'quis nostrud exercitation ullamco',
];

export function generateValue(
  descriptor: FieldDescriptor,
  persona: Persona,
  random: Random,
): FieldValue {
  switch (descriptor.kind) {
    case 'checkbox':
      return toggle(descriptor, random);
    case 'radio':
    case 'select-one':
    case 'select-multiple':
      return choose(descriptor, random);
    default:
      return text(descriptor, persona, random);
  }
}

/**
 * Consent boxes are ticked; everything else is a coin flip.
 *
 * A form that will not submit unless you accept its terms is the common case,
 * and leaving that box unticked makes the fill useless for the thing testers do
 * with it. Required checkboxes are ticked for the same reason.
 */
function toggle(descriptor: FieldDescriptor, random: Random): FieldValue {
  const identity = identityOf(descriptor);
  const consent = /terms|conditions|privacy|policy|agree|accept|consent|gdpr/i.test(identity);
  const required = descriptor.constraints.required === true;

  return {
    ref: descriptor.ref,
    as: 'toggle',
    checked: consent || required ? true : random() < 0.5,
    provenance: consent ? 'consent checkbox → ticked' : required ? 'required → ticked' : 'checkbox → random',
  };
}

/**
 * Picks from the options a control actually offers (UC-004 A3).
 *
 * Eligibility is: enabled, and not the empty placeholder value — wherever the
 * placeholder sits in the list and however many there are. The reference tests
 * option `i` for `disabled` and then selects a *different* random index, so it
 * both selects disabled options and can never select option 0 (D3).
 */
function choose(descriptor: FieldDescriptor, random: Random): FieldValue {
  const options: readonly ControlOption[] = descriptor.options ?? [];
  const eligible = options.filter((option) => !option.disabled && option.value !== '');

  if (eligible.length === 0) {
    // A3.6: recorded as skipped with a reason, and the control left untouched.
    return {
      ref: descriptor.ref,
      as: 'skip',
      reason: 'no-selectable-option',
      provenance: `${options.length} option(s), none selectable`,
    };
  }

  if (descriptor.kind === 'select-multiple') {
    // At least one, at most all, each chosen at most once.
    const count = 1 + Math.floor(random() * eligible.length);
    const pool = [...eligible];
    const picked: string[] = [];
    for (let index = 0; index < count; index++) {
      const [option] = pool.splice(Math.floor(random() * pool.length), 1);
      if (option !== undefined) picked.push(option.value);
    }
    return {
      ref: descriptor.ref,
      as: 'choice',
      values: picked,
      provenance: `multi-select → ${picked.length} of ${eligible.length} eligible`,
    };
  }

  const option = pick(eligible, random);
  return {
    ref: descriptor.ref,
    as: 'choice',
    values: [option.value],
    provenance: `${descriptor.kind} → "${option.label || option.value}"`,
  };
}

function text(descriptor: FieldDescriptor, persona: Persona, random: Random): FieldValue {
  const { value, provenance } = select(descriptor, persona, random);
  return {
    ref: descriptor.ref,
    as: 'text',
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
  // Scalar kinds are decided by what the control accepts, not by identity: a
  // date field wants a date whatever it is called.
  const scalar = scalarValue(descriptor, random);
  if (scalar !== undefined) return scalar;

  const attribute = personaAttribute(descriptor);
  if (attribute !== undefined) {
    return { value: persona[attribute.key], provenance: attribute.provenance };
  }

  // UC-004 A2: no meaningful default for this kind, so a short neutral value
  // sized for it. A textarea gets a paragraph rather than the reference's global
  // 20 characters, which is ND-10's papercut.
  const sentences = descriptor.kind === 'textarea' ? 3 : 1;
  const filler = Array.from({ length: sentences }, () => pick(LOREM, random)).join(', ');
  return { value: `Lorem ipsum ${filler}`, provenance: `kind "${descriptor.kind}" → neutral text` };
}

/**
 * Which persona slot this field wants, and why.
 *
 * A confirmation field resolves to the same slot as the field it confirms
 * (UC-006). That is the whole implementation: because the persona is a record
 * rather than a stream of generated values, both fields reading the same slot
 * agree by construction, and the order they appear in the DOM is irrelevant —
 * the reference mirrors whatever came earlier, so a confirm field appearing
 * *before* its source mirrors lorem ipsum (ND-7).
 */
function personaAttribute(
  descriptor: FieldDescriptor,
): { key: keyof Persona; provenance: string } | undefined {
  const purpose = descriptor.autocomplete;
  if (purpose !== undefined) {
    const key = AUTOCOMPLETE_ATTRIBUTES[purpose];
    if (key !== undefined) {
      return { key, provenance: `autocomplete="${purpose}" → persona.${key}` };
    }
  }

  const identity = identityOf(descriptor);
  const confirming = CONFIRMATION_MARKERS.test(identity);

  for (const [pattern, key] of IDENTITY_HINTS) {
    if (pattern.test(identity)) {
      return {
        key,
        provenance: confirming
          ? `confirms persona.${key} → same value`
          : `identity /${pattern.source}/ → persona.${key}`,
      };
    }
  }

  const byKind = KIND_ATTRIBUTES[descriptor.kind];
  if (byKind !== undefined) {
    return { key: byKind, provenance: `kind "${descriptor.kind}" → persona.${byKind}` };
  }
  return undefined;
}

/**
 * Values for controls whose accepted format the page declares (D9).
 *
 * The reference supports none of `step`, `min` or `max` on numbers and ranges,
 * and no date input types at all, so it generates values the page's own
 * validation rejects.
 */
function scalarValue(
  descriptor: FieldDescriptor,
  random: Random,
): { value: string; provenance: string } | undefined {
  const { min, max, step } = descriptor.constraints;

  switch (descriptor.kind) {
    case 'number':
    case 'range': {
      const low = Number(min ?? 0);
      const high = Number(max ?? (descriptor.kind === 'range' ? 100 : 1000));
      const increment = Number(step ?? 1) || 1;
      // Snapped to the step from `min`, which is what the browser's own
      // validation checks — an unsnapped value in a stepped field is rejected.
      const steps = Math.floor((random() * (high - low)) / increment);
      const value = Math.min(low + steps * increment, high);
      return {
        value: String(Number(value.toFixed(10))),
        provenance: `${descriptor.kind} in [${low}, ${high}] step ${increment}`,
      };
    }

    case 'date':
      return { value: isoDate(random), provenance: 'date → ISO date' };
    case 'datetime-local':
      return { value: `${isoDate(random)}T${isoTime(random)}`, provenance: 'datetime-local' };
    case 'month':
      return { value: isoDate(random).slice(0, 7), provenance: 'month' };
    case 'week': {
      const week = 1 + Math.floor(random() * 52);
      return { value: `2026-W${String(week).padStart(2, '0')}`, provenance: 'week' };
    }
    case 'time':
      return { value: isoTime(random), provenance: 'time' };
    case 'color': {
      const channel = () => Math.floor(random() * 256).toString(16).padStart(2, '0');
      return { value: `#${channel()}${channel()}${channel()}`, provenance: 'color' };
    }
    default:
      return undefined;
  }
}

function isoDate(random: Random): string {
  const year = 1970 + Math.floor(random() * 55);
  const month = 1 + Math.floor(random() * 12);
  // 28 avoids inventing a 31st of February, which no page's validation accepts.
  const day = 1 + Math.floor(random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoTime(random: Random): string {
  const hour = Math.floor(random() * 24);
  const minute = Math.floor(random() * 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
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

/** Every matching source as one lower-cased haystack, for the hint patterns. */
function identityOf(descriptor: FieldDescriptor): string {
  return Object.values(descriptor.sources).join(' ').toLowerCase();
}

function pick<T>(items: readonly T[], random: Random): T {
  // `Math.floor(random() * length)`, not `* (length - 1)`: the reference's
  // arithmetic makes the last entry of every array unreachable (D7).
  return items[Math.floor(random() * items.length)] as T;
}
