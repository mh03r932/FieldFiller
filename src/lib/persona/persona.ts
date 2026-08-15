/**
 * One coherent fictional person per fill (ND-1, FR-023, BR-004-1).
 *
 * This is the single biggest quality difference available over the reference,
 * and it is only cheap if it exists from the start. `ElementFiller` generates
 * each field in isolation as it walks, so a filled form comes out internally
 * incoherent — first name *Maria*, full name *John Smith*, an email unrelated to
 * either — and it patches around that with five mutable instance fields and an
 * option that stitches an email out of whatever names happened to appear
 * earlier. Retrofitting coherence onto a single-pass walker is a rewrite.
 *
 * The persona is created when the fill begins, before any control is examined
 * (BR-004-1a). That ordering is what makes a multi-frame fill possible without
 * coordinating the frames: each reports independently and receives values drawn
 * from a person who already exists, so no frame waits for another and a frame
 * that never reports delays nothing.
 *
 * Background-only, by the import gate: this module and its corpus must never
 * reach the page agent (DD-003, ND-4). `scripts/check-imports.mjs` enforces it,
 * and the corpus is the reason it matters — it is by some way the largest thing
 * the extension ships, and a stray import would put all of it into every page.
 */

import { between, pick, type Corpus, type Locale } from './corpus/corpus';
import { EN_US } from './corpus/en-US';
import { DE_CH } from './corpus/de-CH';

export type { Locale } from './corpus/corpus';
export { LOCALES } from './corpus/corpus';

export type Persona = {
  readonly firstName: string;
  readonly lastName: string;
  /**
   * The account password, part of the record rather than generated per field.
   *
   * This is what makes UC-006 nearly free: "confirm password" resolves to the
   * same slot as "password", so the two agree by construction. The reference
   * stashes the last generated value in a mutable `previousValue` shared by text
   * *and* email fields and replays it, so any text input between the two
   * silently clobbers what gets mirrored (ND-7).
   */
  readonly password: string;
  readonly fullName: string;
  readonly username: string;
  readonly email: string;
  readonly phone: string;
  readonly organisation: string;
  readonly streetAddress: string;
  readonly locality: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
  readonly countryCode: string;
  readonly url: string;

  /** A second address line, which a great many forms ask for and few require. */
  readonly addressLine2: string;
  /** The abbreviation a state or canton select expects, beside the full name. */
  readonly regionCode: string;
  /** ISO `YYYY-MM-DD`, so a `type="date"` input takes it without reformatting. */
  readonly dateOfBirth: string;
  readonly jobTitle: string;
  /**
   * The national identifier this locale's forms ask for, or `''` where the
   * locale has none this project will emit.
   *
   * Swiss AHV numbers carry a check digit, so a generated one is visibly
   * constructed and a form that validates the format accepts it — which is the
   * only reason to emit one. A US Social Security number has no checksum, so a
   * generated one is indistinguishable from a real one, and none is produced.
   */
  readonly nationalId: string;
  /** An IBAN with correct check digits, or `''` where the locale has none. */
  readonly iban: string;
};

/**
 * A seedable random source (BR-004-14).
 *
 * Randomness is a runtime default, not a property of the design. Without a seed
 * the engine's output cannot be asserted in a test, which is a large part of why
 * the reference has none. Deterministic here means: same seed, same persona.
 */
export type Random = () => number;

/** mulberry32 — small, fast, and good enough for dummy data. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A password that would actually pass a registration form.
 *
 * The reference's is `scrambledWord(8,8).toLowerCase()` — eight alternating
 * lowercase letters, no digit, no uppercase, no symbol — which fails the very
 * forms the feature exists to fill (ND-11). Per-field policy from `pattern` and
 * `minlength` is applied by the generator on top of this.
 */
function password(random: Random): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const numerals = '23456789';
  const symbols = '!@#$%&*';
  const from = (set: string, count: number) =>
    Array.from({ length: count }, () => set[Math.floor(random() * set.length)]).join('');

  return `${from(upper, 1)}${from(lower, 8)}${from(numerals, 3)}${from(symbols, 1)}`;
}

/**
 * A date of birth for an adult, as ISO `YYYY-MM-DD`.
 *
 * Bounded to 18–80 so the value passes the age check a registration form is
 * likely to apply — a date of birth that fails validation tells the tester
 * nothing about their form, which is the same argument the check digits make.
 * Days stop at 28 so no month is ever given a day it does not have.
 */
function dateOfBirth(random: Random): string {
  const year = new Date().getUTCFullYear() - between(18, 80, random);
  const month = String(between(1, 12, random)).padStart(2, '0');
  const day = String(between(1, 28, random)).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

/** The corpus for a locale. A closed union, so a typo cannot select nothing. */
export function corpusFor(locale: Locale): Corpus {
  return locale === 'de-CH' ? DE_CH : EN_US;
}

/**
 * One coherent person, drawn from one locale's corpus.
 *
 * Everything after the four picks is *derived* from them. That derivation is the
 * whole point: the email belongs to the name because it was built from it, not
 * because a later generator was told to look at a previous field's output — and
 * the postcode belongs to the city because they were chosen as one thing.
 */
export function createPersona(random: Random, locale: Locale = 'en-US'): Persona {
  const corpus = corpusFor(locale);

  const firstName = pick(corpus.firstNames, random);
  const lastName = pick(corpus.lastNames, random);
  const place = pick(corpus.places, random);
  const organisation = `${pick(corpus.organisationStems, random)} ${pick(corpus.organisationSuffixes, random)}`;
  const street = `${pick(corpus.streetStems, random)}${corpus.locale === 'de-CH' ? '' : ' '}${pick(corpus.streetSuffixes, random)}`;

  // Diacritics are folded for the machine-readable derivations only. `Müller`
  // stays `Müller` in the name field and becomes `mueller` in the address,
  // because that is what the person would have typed when they registered.
  const slug = `${firstName}.${lastName}`
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[^a-z.]/g, '');
  const domain = `${(organisation.split(' ')[0] ?? 'example').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.test`;

  return {
    firstName,
    lastName,
    password: password(random),
    fullName: `${firstName} ${lastName}`,
    username: slug.replace('.', ''),
    email: `${slug}@${domain}`,
    phone: corpus.phone(random),
    organisation,
    streetAddress: corpus.streetLine(street, between(1, 148, random)),
    addressLine2: `${corpus.locale === 'de-CH' ? 'Stock' : 'Apt'} ${String(between(1, 24, random))}`,
    locality: place.locality,
    region: place.region,
    regionCode: place.regionCode,
    postalCode: corpus.postalCode(place, random),
    country: corpus.country,
    countryCode: corpus.countryCode,
    url: `https://www.${domain}`,
    dateOfBirth: dateOfBirth(random),
    jobTitle: pick(corpus.jobTitles, random),
    // `''` rather than a plausible-looking value where the locale has none. A
    // field left empty is visible; a fabricated identifier is not.
    nationalId: corpus.nationalId?.(random) ?? '',
    iban: corpus.iban?.(random) ?? '',
  };
}
