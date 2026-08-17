import { describe, expect, it } from 'vitest';
import { corpusFor, LOCALES } from '@/lib/persona/persona';
import type { Corpus } from '@/lib/persona/corpus/corpus';

/**
 * The data itself, checked mechanically.
 *
 * `persona.test.ts` asserts that a generated record is *internally* coherent —
 * that its postal code belongs to its city — but it does that by looking the
 * city up in the same table the generator drew from. That proves the pairing
 * survives generation. It cannot prove the pairing is **true**: a wrong PLZ
 * typed into the corpus would satisfy it perfectly.
 *
 * Nothing in a unit test can close that gap, because the fact is external. What
 * these checks do is narrow it to the mistakes a person actually makes when
 * typing a few hundred rows — a canton code that is not a canton, a four-digit
 * ZIP, a duplicate entry that quietly doubles one name's odds — so that the
 * residue is "this is the wrong real place" rather than "this is not a place".
 * The limitation is stated in `docs/requirements.md` rather than left implied.
 */

/** The twenty-six cantons. A code outside this set is a typo, not a place. */
const CANTONS = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);

/** The fifty states plus the District of Columbia. */
const STATES = new Set([
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA',
  'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS',
  'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
]);

/** Every list a corpus holds, so a new one cannot be added without being checked. */
function listsOf(corpus: Corpus): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['firstNames', corpus.firstNames],
    ['lastNames', corpus.lastNames],
    ['streetStems', corpus.streetStems],
    ['streetSuffixes', corpus.streetSuffixes],
    ['organisationStems', corpus.organisationStems],
    ['organisationSuffixes', corpus.organisationSuffixes],
    ['jobTitles', corpus.jobTitles],
  ];
}

describe.each(LOCALES)('the %s corpus', (locale) => {
  const corpus = corpusFor(locale);

  it.each(listsOf(corpus))('has no duplicate in %s', (_name, entries) => {
    // A duplicate is not an error the engine can see: it just makes one entry
    // twice as likely as its neighbours, forever, silently.
    const seen = new Set(entries);
    const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
    expect(duplicates, `duplicated: ${[...new Set(duplicates)].join(', ')}`).toEqual([]);
    expect(seen.size).toBe(entries.length);
  });

  it.each(listsOf(corpus))('has no blank or untrimmed entry in %s', (_name, entries) => {
    for (const entry of entries) {
      expect(entry).not.toBe('');
      expect(entry, `"${entry}" has surrounding whitespace`).toBe(entry.trim());
    }
  });

  it('names each place exactly once per region', () => {
    // Portland ME and Portland OR are both real and both wanted; Portland OR
    // twice is a paste. The pair is the identity, not the name.
    const keys = corpus.places.map((place) => `${place.locality}|${place.regionCode}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every place a region name and a region code that agree', () => {
    // One region code must map to exactly one region name across the corpus. A
    // city filed under `ZH` with the region spelled `Zurich` in one row and
    // `Zürich` in another is the kind of thing a select on a real form rejects.
    const byCode = new Map<string, string>();
    for (const place of corpus.places) {
      const known = byCode.get(place.regionCode);
      if (known === undefined) byCode.set(place.regionCode, place.region);
      else expect(place.region, `${place.regionCode} is spelled two ways`).toBe(known);
    }
  });

  it('has a corpus large enough to be worth having', () => {
    // The complaint that prompted this: eight names, repeating on the ninth
    // fill. The floor is deliberately far below what is shipped, so this fails
    // on a corpus that was gutted rather than on one that was trimmed.
    expect(corpus.firstNames.length).toBeGreaterThan(100);
    expect(corpus.lastNames.length).toBeGreaterThan(100);
    expect(corpus.places.length).toBeGreaterThan(20);
  });
});

describe('the de-CH corpus specifically', () => {
  const corpus = corpusFor('de-CH');

  it('files every municipality under a real canton', () => {
    for (const place of corpus.places) {
      expect(CANTONS.has(place.regionCode), `${place.locality}: "${place.regionCode}" is not a canton`).toBe(true);
    }
  });

  it('gives every municipality a four-digit PLZ', () => {
    // A Swiss postal code is four digits and complete — unlike a ZIP prefix,
    // there is nothing left to generate, so a wrong length here is a wrong code.
    for (const place of corpus.places) {
      expect(place.postalPrefix, place.locality).toMatch(/^\d{4}$/);
    }
  });

  it('keeps the PLZ inside the range its canton actually uses', () => {
    // The leading digit of a PLZ is regional, so it correlates with canton
    // strongly enough to catch a transposition — 8001 in Genève would fail this
    // even though both halves are individually real. Cantons that genuinely
    // straddle a boundary are listed with every digit they use.
    const leading: Record<string, readonly string[]> = {
      GE: ['1'], VD: ['1'], VS: ['1', '3'], FR: ['1', '3'], NE: ['2'], JU: ['2'],
      BE: ['2', '3'], SO: ['2', '4'], BL: ['4'], BS: ['4'], AG: ['4', '5'],
      LU: ['6'], OW: ['6'], NW: ['6'], UR: ['6'], SZ: ['6'], ZG: ['6'], TI: ['6'],
      GR: ['7'], GL: ['8'], ZH: ['8'], SH: ['8'], TG: ['8'], AR: ['9'], AI: ['9'],
      SG: ['8', '9'],
    };
    for (const place of corpus.places) {
      const allowed = leading[place.regionCode];
      expect(allowed, `no PLZ range recorded for ${place.regionCode}`).toBeDefined();
      expect(
        allowed!.includes(place.postalPrefix[0]!),
        `${place.locality} ${place.postalPrefix} does not sit in ${place.regionCode}`,
      ).toBe(true);
    }
  });

  it('writes street names as one word, the way the country does', () => {
    // `Ahornweg`, not `Ahorn Weg`. The suffix is joined without a space, so a
    // suffix that carried its own leading capital or space would produce an
    // address that reads as a translation.
    for (const suffix of corpus.streetSuffixes) {
      expect(suffix, `"${suffix}" would not join cleanly`).toMatch(/^[a-zäöü]+$/);
    }
  });
});

describe('the en-US corpus specifically', () => {
  const corpus = corpusFor('en-US');

  it('files every city under a real state', () => {
    for (const place of corpus.places) {
      expect(STATES.has(place.regionCode), `${place.locality}: "${place.regionCode}" is not a state`).toBe(true);
    }
  });

  it('gives every city a three-digit ZIP prefix', () => {
    // Three digits is the level at which a prefix belongs to a place rather than
    // a delivery route; the generator adds the final two.
    for (const place of corpus.places) {
      expect(place.postalPrefix, place.locality).toMatch(/^\d{3}$/);
    }
  });

  it('keeps every ZIP prefix inside the band its state was allocated', () => {
    // ZIP prefixes are allocated by state in contiguous bands, so a
    // transposition shows up here even though both halves look plausible.
    const bands: Record<string, ReadonlyArray<readonly [number, number]>> = {
      AK: [[995, 999]], AL: [[350, 369]], AR: [[716, 729]], AZ: [[850, 865]],
      CA: [[900, 961]], CO: [[800, 816]], CT: [[60, 69]], DE: [[197, 199]],
      FL: [[320, 349]], GA: [[300, 319]], HI: [[967, 968]], IA: [[500, 528]],
      ID: [[832, 838]], IL: [[600, 629]], IN: [[460, 479]], KS: [[660, 679]],
      KY: [[400, 427]], LA: [[700, 714]], MA: [[10, 27]], MD: [[206, 219]],
      ME: [[39, 49]], MI: [[480, 499]], MN: [[550, 567]], MO: [[630, 658]],
      MS: [[386, 397]], NC: [[270, 289]], ND: [[580, 588]], NE: [[680, 693]],
      NH: [[30, 38]], NJ: [[70, 89]], NM: [[870, 884]], NV: [[889, 898]],
      NY: [[100, 149]], OH: [[430, 459]], OK: [[730, 749]], OR: [[970, 979]],
      PA: [[150, 196]], RI: [[28, 29]], SC: [[290, 299]], SD: [[570, 577]],
      TN: [[370, 385]], TX: [[750, 799]], UT: [[840, 847]], VA: [[220, 246]],
      WA: [[980, 994]], WI: [[530, 549]],
    };
    for (const place of corpus.places) {
      const allowed = bands[place.regionCode];
      expect(allowed, `no ZIP band recorded for ${place.regionCode}`).toBeDefined();
      const prefix = Number(place.postalPrefix);
      expect(
        allowed!.some(([low, high]) => prefix >= low && prefix <= high),
        `${place.locality} ${place.postalPrefix} is outside ${place.regionCode}'s band`,
      ).toBe(true);
    }
  });
});
