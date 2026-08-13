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
 * reach the page agent (DD-003, ND-4).
 */

export type Persona = {
  readonly firstName: string;
  readonly lastName: string;
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
  readonly url: string;
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
 * A deliberately tiny corpus. Phase 2 replaces it with a real one, loaded once
 * per background lifetime and measured against the cold-start budget
 * (NFR-027..029). Phase 1 only needs enough to prove that coherence is a
 * property of the record rather than a correlation between generators.
 */
const FIRST_NAMES = ['Ada', 'Bram', 'Chidi', 'Dagny', 'Emil', 'Farida', 'Gwen', 'Hakim'];
const LAST_NAMES = ['Ashworth', 'Beaumont', 'Calder', 'Devereux', 'Engström', 'Fairbairn'];
const STREETS = ['Alder Row', 'Bexley Lane', 'Cobden Street', 'Dunmore Way', 'Elmfield Road'];
const ORGANISATIONS = ['Northwind Logistics', 'Palegate Systems', 'Quarrymill Foods'];

/** Locality, region and postcode agree by construction, never by luck (BR-004-2). */
const PLACES = [
  { locality: 'Bristol', region: 'England', postalCode: 'BS1 4DJ' },
  { locality: 'Aberdeen', region: 'Scotland', postalCode: 'AB10 1XG' },
  { locality: 'Swansea', region: 'Wales', postalCode: 'SA1 3RD' },
] as const;

function pick<T>(items: readonly T[], random: Random): T {
  // `Math.floor(random() * length)`, not `* (length - 1)`: the reference's
  // arithmetic makes the last entry of every array unreachable (D7).
  return items[Math.floor(random() * items.length)] as T;
}

export function createPersona(random: Random): Persona {
  const firstName = pick(FIRST_NAMES, random);
  const lastName = pick(LAST_NAMES, random);
  const place = pick(PLACES, random);
  const organisation = pick(ORGANISATIONS, random);

  // Everything below derives from what was chosen above. That derivation is the
  // whole point: the email belongs to the name because it was built from it, not
  // because a later generator was told to look at a previous field's output.
  const slug = `${firstName}.${lastName}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '');
  const domain = `${organisation.split(' ')[0]?.toLowerCase() ?? 'example'}.test`;

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    username: slug.replace('.', ''),
    email: `${slug}@${domain}`,
    // A UK persona gets a UK number, because the address is UK too.
    phone: `+44 7${String(Math.floor(random() * 900_000_000) + 100_000_000)}`,
    organisation,
    streetAddress: `${Math.floor(random() * 120) + 1} ${pick(STREETS, random)}`,
    locality: place.locality,
    region: place.region,
    postalCode: place.postalCode,
    country: 'United Kingdom',
    url: `https://www.${domain}`,
  };
}
