import type { ControlKind, ControlOption, FieldDescriptor, FieldValue } from '../protocol';
import type { Persona, Random } from '../persona/persona';
import { pick } from '../persona/corpus/corpus';
import {
  DEFAULT_CONFIRMATION_KEYWORDS,
  DEFAULT_CONSENT_KEYWORDS,
  escapeRegex,
} from '../settings';

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
  'address-line2': 'addressLine2',
  'address-level2': 'locality',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'countryCode',
  'country-name': 'country',
  url: 'url',
  bday: 'dateOfBirth',
  'organization-title': 'jobTitle',
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
 * The configurable half of UC-022, as one value (FR-015, FR-024, FR-049).
 *
 * Optional at every call site, defaulting to what the extension ships. That is
 * not laziness about threading it: `generateValue`, `mirrorsAnotherField` and
 * `constrain` are all exported and all called from tests that care about one
 * control's behaviour and nothing about settings, and a required parameter would
 * have made every one of them state a policy it has no opinion on.
 */
export type BehaviourDefaults = {
  readonly consentKeywords: readonly string[];
  readonly confirmationKeywords: readonly string[];
  /** Per-kind caps, used only where the control declares no `maxlength`. */
  readonly maxLengths: Partial<Record<ControlKind, number>>;
};

const SHIPPED_DEFAULTS: BehaviourDefaults = {
  consentKeywords: DEFAULT_CONSENT_KEYWORDS,
  confirmationKeywords: DEFAULT_CONFIRMATION_KEYWORDS,
  maxLengths: {},
};

/**
 * A keyword list as one case-insensitive alternation.
 *
 * Every keyword is escaped, so the list is literal substrings and nothing else:
 * a user typing `c++` into the consent keywords gets a keyword rather than a
 * syntax error, and no configured word can introduce the backtracking NFR-009
 * keeps off this path. Built once per call rather than once per keyword per
 * field, which is ND-15's argument at a smaller scale.
 *
 * An empty list compiles to `undefined` rather than to an empty pattern — `//`
 * matches everything, so an emptied consent list would tick every checkbox on
 * the page, which is the exact opposite of what emptying it asks for.
 */
function keywordPattern(keywords: readonly string[]): RegExp | undefined {
  const usable = keywords.filter((keyword) => keyword !== '');
  return usable.length === 0
    ? undefined
    : new RegExp(usable.map(escapeRegex).join('|'), 'i');
}

/**
 * Whether a trailing ordinal marks a confirmation, independent of any keyword.
 *
 * `password2` beside `password` is a confirmation, and that is a convention
 * about shape rather than a word — so it stays here instead of appearing in the
 * configurable list, where it could only be expressed with the anchors that list
 * deliberately escapes away. UC-022 states the split, because a screen offering
 * "confirmation keywords" would otherwise be read as offering all of it.
 */
const ORDINAL_CONFIRMATION = /_2$|2$/;

/**
 * Whether a field's identity marks it as confirming another (UC-006, D2).
 *
 * Tested against every matching source, not just `element.name`. The reference
 * tests `name` alone, so a "Confirm password" field identified only by its `id`
 * or its `<label>` never mirrors the original — even though matching for
 * everything else uses all sources (D2).
 */
function confirmationMarked(identity: string, keywords: readonly string[]): boolean {
  return ORDINAL_CONFIRMATION.test(identity) || (keywordPattern(keywords)?.test(identity) ?? false);
}

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
  // Above the street, not below it: `address2` matches both patterns and the
  // first match wins, so a second line placed after the first never resolved by
  // identity at all — it took the street's slot, and `2$` then made it a
  // confirmation of the street, so both lines came out identical. Plain
  // `address` carries no ordinal and is unaffected.
  //
  // The short words are fenced against letters rather than left bare, which
  // matters now that this entry outranks the address, city and region hints:
  // `identityOf` joins every source, so an unfenced `apt` matches `adaptive` in
  // a class name and an unfenced `stock` matches a city field suggesting
  // `Stockholm`. Fenced against letters and not `\b`, so `apt_2` and `stock-3`
  // still match — an underscore is a word character and `\b` would refuse them.
  [/address[\s_-]*(line)?[\s_-]*2|apartment|(?<![a-z])(apt|suite|stock(werk)?)(?![a-z])/i, 'addressLine2'],
  [/address|street/i, 'streetAddress'],
  [/city|town|locality/i, 'locality'],
  [/state|province|region|county/i, 'region'],
  [/country/i, 'country'],
  [/company|organisation|organization|employer/i, 'organisation'],
  [/web[\s_-]*site|homepage|url/i, 'url'],
  [/birth|geburt|dob\b/i, 'dateOfBirth'],
  [/job[\s_-]*title|position|beruf|funktion/i, 'jobTitle'],
  // The identifiers this locale emits. A locale without one leaves the slot
  // empty, and an empty slot falls through to A2's neutral value rather than
  // writing nothing and calling the field filled.
  [/ahv|avs|social[\s_-]*security|versicherten/i, 'nationalId'],
  [/iban|bank[\s_-]*account|kontonummer/i, 'iban'],
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
  defaults: BehaviourDefaults = SHIPPED_DEFAULTS,
): FieldValue {
  switch (descriptor.kind) {
    case 'checkbox':
      return toggle(descriptor, random, defaults);
    case 'radio':
    case 'select-one':
    case 'select-multiple':
      return choose(descriptor, random);
    case 'combobox':
      return offeredPosition(descriptor, random);
    default:
      return text(descriptor, persona, random, defaults);
  }
}

/**
 * A custom combobox, whose options nobody here has seen (FR-081).
 *
 * The control does not publish what it offers until it is opened, and opening it
 * is an interaction with the page — which the background cannot perform and must
 * not learn the result of. So what is generated is the *draw*, not the answer:
 * a position in a list of unknown length, which the agent maps onto whatever the
 * control turned out to hold.
 *
 * Seeded from the same stream as everything else, so it is as stable across
 * passes as any other value (FR-080). Re-driving a combobox the page reset picks
 * the same position again, and — if the page is offering the same list — the
 * same answer.
 *
 * FR-082 will want the labels, to prefer the option matching the persona's
 * country or region. That needs the agent to describe the control again once it
 * is open, and is deliberately left undecided here rather than half-built.
 */
function offeredPosition(descriptor: FieldDescriptor, random: Random): FieldValue {
  return {
    ref: descriptor.ref,
    as: 'pick',
    at: random(),
    provenance: 'combobox → position in the offered list',
  };
}

/**
 * Consent boxes are ticked; everything else is a coin flip.
 *
 * A form that will not submit unless you accept its terms is the common case,
 * and leaving that box unticked makes the fill useless for the thing testers do
 * with it. Required checkboxes are ticked for the same reason.
 */
function toggle(
  descriptor: FieldDescriptor,
  random: Random,
  defaults: BehaviourDefaults,
): FieldValue {
  const identity = identityOf(descriptor);
  const consent = keywordPattern(defaults.consentKeywords)?.test(identity) ?? false;
  // Not configurable, and deliberately: an unticked required box blocks the
  // submission the fill exists to reach, so this one is a property of the form
  // rather than a preference (UC-022, BR-022-3).
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

function text(
  descriptor: FieldDescriptor,
  persona: Persona,
  random: Random,
  defaults: BehaviourDefaults,
): FieldValue {
  const { value, provenance } = select(descriptor, persona, random, defaults);
  return {
    ref: descriptor.ref,
    as: 'text',
    // BR-004-7: the control's own constraints are a ceiling. A value the page's
    // own validation would reject is a defect, not a choice — and the reference
    // computes an effective maxLength and then discards it (D4).
    value: constrain(value, descriptor, defaults.maxLengths),
    provenance,
  };
}

function select(
  descriptor: FieldDescriptor,
  persona: Persona,
  random: Random,
  defaults: BehaviourDefaults,
): { value: string; provenance: string } {
  // Scalar kinds are decided by what the control accepts, not by identity: a
  // date field wants a date whatever it is called.
  const scalar = scalarValue(descriptor, random);
  if (scalar !== undefined) return scalar;

  const attribute = personaAttribute(descriptor, defaults.confirmationKeywords);
  if (attribute !== undefined) {
    const value = persona[attribute.key];
    // An empty slot means this locale has no such thing — a US persona has no
    // AHV number. Writing `''` would report the control as filled while leaving
    // it blank, so it falls through to A2's neutral value instead, and the
    // provenance says which slot was empty rather than pretending none matched.
    if (value !== '') return { value, provenance: attribute.provenance };
  }

  // UC-004 A2: no meaningful default for this kind, so a short neutral value
  // sized for it. A textarea gets a paragraph rather than the reference's global
  // 20 characters, which is ND-10's papercut.
  const sentences = descriptor.kind === 'textarea' ? 3 : 1;
  const filler = Array.from({ length: sentences }, () => pick(LOREM, random)).join(', ');
  return { value: `Lorem ipsum ${filler}`, provenance: `kind "${descriptor.kind}" → neutral text` };
}

/**
 * Whether this field mirrors another one (UC-006, FR-024).
 *
 * Exported because a matching rule loses to mirroring (DD-005). A confirmation
 * field that does not equal the field it confirms fails the page's own
 * validation — which is the entire reason the field exists — so honouring a rule
 * there would produce a form that cannot be submitted. The rule is named in the
 * report as overridden rather than dropped in silence.
 *
 * Both halves are required: the marker says the field confirms something, and a
 * resolvable persona slot says there is something for it to agree *with*. A
 * field called `repeat_order_reference` matches the marker and resolves to no
 * slot, so it is not mirroring anything and a rule applies to it normally.
 */
export function mirrorsAnotherField(
  descriptor: FieldDescriptor,
  defaults: BehaviourDefaults = SHIPPED_DEFAULTS,
): boolean {
  const keywords = defaults.confirmationKeywords;
  const attribute = personaAttribute(descriptor, keywords);
  return attribute !== undefined && confirms(identityOf(descriptor), attribute.key, keywords);
}

/**
 * Whether a trailing ordinal means "again" or "the next one".
 *
 * The ordinal earns its place beside the keywords because `password2` beside
 * `password` is a confirmation, and that is much the commonest shape. The second
 * address line is the exception, and the only one: `address2` is the *next*
 * line, not the same line said twice. Treated as a confirmation it drags the
 * street address onto both lines — and, through `mirrorsAnotherField`, silently
 * overrides a user rule aimed at a field that confirms nothing (DD-005).
 */
function confirms(identity: string, key: keyof Persona, keywords: readonly string[]): boolean {
  return key !== 'addressLine2' && confirmationMarked(identity, keywords);
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
  keywords: readonly string[],
): { key: keyof Persona; provenance: string } | undefined {
  const purpose = descriptor.autocomplete;
  if (purpose !== undefined) {
    const key = AUTOCOMPLETE_ATTRIBUTES[purpose];
    if (key !== undefined) {
      return { key, provenance: `autocomplete="${purpose}" → persona.${key}` };
    }
  }

  const identity = identityOf(descriptor);

  for (const [pattern, key] of IDENTITY_HINTS) {
    if (pattern.test(identity)) {
      return {
        key,
        provenance: confirms(identity, key, keywords)
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
      // Constraints are attribute strings, so they are whatever the page wrote:
      // `min="abc"` parses to NaN, which propagates through the arithmetic and
      // serialises as the literal string "NaN" — a value no numeric field
      // accepts. Anything non-finite falls back to the default it displaced.
      const low = finite(min, 0);
      const high = finite(max, descriptor.kind === 'range' ? 100 : 1000);
      const increment = finite(step, 1) || 1;
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

/** A finite number from an untrusted attribute string, or the fallback. */
function finite(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

/**
 * Fits a value to what the control will accept (BR-004-7, FR-072).
 *
 * Exported because a rule's output goes through exactly this (DD-005): the rule
 * supplies policy, the page supplies the ceiling, and the page wins. A rule that
 * could bypass the fitter would reintroduce ND-11 through the settings screen.
 */
export function constrain(
  value: string,
  descriptor: FieldDescriptor,
  maxLengths: Partial<Record<ControlKind, number>> = {},
): string {
  const { minLength } = descriptor.constraints;
  // The page first, the user's per-kind cap only where the page declares none
  // (FR-065, ND-10, UC-022). That order is the whole of the setting's meaning: a
  // configured cap that overrode a declared `maxlength` would produce values the
  // form's own validation rejects, which is ND-11 arriving through the settings
  // screen instead of through the generator.
  const maxLength = descriptor.constraints.maxLength ?? maxLengths[descriptor.kind];
  let result = value;

  if (minLength !== undefined && result.length < minLength) {
    result = result.padEnd(minLength, 'x');
  }
  if (maxLength !== undefined && result.length > maxLength) {
    // A password must survive its own ceiling. Plain slicing takes the tail
    // off — where the symbol and digits happen to sit — so a field with
    // `maxlength="10"` would receive a value that fails exactly the registration
    // policy ND-11 exists to satisfy: constrained, and useless.
    result = descriptor.kind === 'password' ? fitPassword(result, maxLength) : result.slice(0, maxLength);
  }

  return descriptor.kind === 'password' ? fitPasswordPattern(result, descriptor) : result;
}

/**
 * Whether a value satisfies a control's `pattern` (D9, FR-072).
 *
 * The attribute is implicitly anchored at both ends — `pattern="\d{4}"` means
 * the whole value is four digits, not that four digits appear in it — so the
 * anchors are added here rather than trusted to be in the attribute.
 *
 * An unparseable pattern counts as satisfied. We cannot judge against a rule we
 * cannot read, and refusing to fill the field would punish the user for the
 * page's mistake; the browser will not enforce it either. This is the same call
 * UC-005 A5 makes for an invalid ignore pattern.
 */
function satisfiesPattern(value: string, pattern: string | undefined): boolean {
  if (pattern === undefined) return true;
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(value);
  } catch {
    try {
      // `v` is the flag the HTML spec requires, and it rejects some patterns an
      // older `u`-flag regex accepted. Falling back rather than giving up keeps
      // us matching whatever the page's own browser would do.
      return new RegExp(`^(?:${pattern})$`, 'u').test(value);
    } catch {
      return true;
    }
  }
}

/**
 * Bends a generated password towards the field's own `pattern` (FR-072).
 *
 * Satisfying an arbitrary regular expression is not solvable in general — that
 * is FR-021's regex generator, and it needs a rule model that does not exist
 * yet. What is solvable is the shape real registration forms actually use: a
 * restricted character set. `[A-Za-z0-9]{8,}` and `[A-Za-z0-9!@#$%^&*]{8,}` are
 * most of the population, and both reject our default password for exactly one
 * reason — the symbol it chose.
 *
 * So this is a bounded ladder over that one variable, not a search. Where none
 * of the rungs fits, the original value is kept and the write-verification step
 * reports the control as failed rather than the fill claiming a value the page
 * will reject (FR-076). A wrong password reported as filled is the outcome worth
 * avoiding; a right one is a bonus.
 */
function fitPasswordPattern(password: string, descriptor: FieldDescriptor): string {
  const { pattern, minLength } = descriptor.constraints;
  if (pattern === undefined || satisfiesPattern(password, pattern)) return password;

  const body = password.replace(/[^A-Za-z0-9]/g, '');
  const floor = minLength ?? 0;
  const candidates = [
    password.replace(/[^A-Za-z0-9]/g, '!'),
    password.replace(/[^A-Za-z0-9]/g, '@'),
    password.replace(/[^A-Za-z0-9]/g, '-'),
    body,
    // Removing the symbol can drop below a length floor the ceiling had already
    // squeezed against, so the alphanumeric rungs are re-padded before testing.
    body.padEnd(floor, 'x'),
  ];

  for (const candidate of candidates) {
    if (satisfiesPattern(candidate, pattern)) return candidate;
  }
  return password;
}

/** The four composition classes, in the order a shortened password keeps them. */
const PASSWORD_CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/] as const;

/**
 * Shortens a password while keeping one of each character class it uses.
 *
 * Rebuilt from the original's own characters rather than generated afresh, so
 * two fields with the same ceiling still agree — which is what keeps "confirm
 * password" mirroring correctly (UC-006) when both carry a `maxlength`.
 *
 * **Only the classes actually present.** What was here defaulted each missing
 * class to a literal — `'A'`, `'7'`, `'!'` — which was harmless while every
 * password came from one hard-coded recipe and became wrong the moment FR-025's
 * policy was configurable: a user who switched symbols off got one back from the
 * fitter, on exactly the fields whose `maxlength` made them likeliest to have a
 * character-set restriction too. It is also wrong for a rule-generated value,
 * where the composition is the user's and not ours to top up.
 *
 * Everything else is filled from the password's own remaining characters, in
 * their original order, so the result is a subsequence of what came in.
 *
 * Below four characters no policy of this kind can be met. The control's own
 * limit still wins, because a value the page rejects for length is worse than
 * one it rejects for composition (BR-004-7).
 */
function fitPassword(password: string, maxLength: number): string {
  if (maxLength < 4) return password.slice(0, maxLength);

  const keep = new Set<number>();
  for (const characterClass of PASSWORD_CLASSES) {
    const at = password.search(characterClass);
    if (at !== -1) keep.add(at);
  }
  // At most four, and `maxLength` is at least four, so the classes always fit
  // and this loop always has room to run.
  for (let index = 0; index < password.length && keep.size < maxLength; index++) {
    keep.add(index);
  }

  return [...password].filter((_, index) => keep.has(index)).join('');
}

/** Every matching source as one lower-cased haystack, for the hint patterns. */
function identityOf(descriptor: FieldDescriptor): string {
  return Object.values(descriptor.sources).join(' ').toLowerCase();
}

