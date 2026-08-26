#!/usr/bin/env node
/**
 * The i18n catalog is load-bearing for the whole extension, not just its own
 * strings.
 *
 * Chrome validates `_locales/<default_locale>/messages.json` when it installs
 * the extension, and a message that uses a `$VARIABLE$` with no matching
 * `placeholders` entry fails that validation — refusing to load the extension
 * AT ALL, with `Variable $X$ used but not defined` in a log nobody reads.
 * Every other surface then reports the same symptom: the options page is a
 * blocked origin, the background never starts, an end-to-end harness times
 * out waiting for a service worker that was never permitted to exist.
 *
 * That failure mode is not hypothetical; it is how this gate came to exist.
 * A migration feature added twenty-one catalog entries on 2026-08-26, every
 * unit test passed (nothing loads the catalog through Chrome), the size and
 * import gates passed, and the built extension silently would not install.
 * The e2e harnesses catch it, but they are the slowest tier and the last to
 * run — a gate here turns that into a failure at `pnpm run gate:messages`
 * speed, naming the key and the variable.
 *
 * What is checked, and only what was observed to break plus what keeps the
 * observed break from returning by a side door:
 *
 *   1. the catalog parses as JSON, in every locale directory under
 *      `public/_locales/`;
 *   2. each entry is an object with a non-empty `message`;
 *   3. every `$NAME$` in a message is declared in that entry's
 *      `placeholders`, lowercased, as Chrome matches them;
 *   4. each placeholder's `content` is `$N` for its position, 1-based and
 *      contiguous — the convention every existing entry follows, and what
 *      `message(key, params)` in `lib/platform/i18n.ts` relies on when it
 *      hands Chrome a positional array.
 *
 * Deliberately NOT checked: wording, descriptions, `example` fields, and
 * which keys exist in which locale. The catalog is hand-authored and its
 * coverage is a translation concern; the failure that hides an entire
 * extension is a structural one, and that is the line this gate holds.
 *
 * Usage: node scripts/check-messages.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'public', '_locales');

/** `$NAME$` where NAME is alphanumeric — Chrome's placeholder reference form. */
const VARIABLE = /\$([A-Za-z0-9_]+)\$/g;

const failures = [];

function fail(locale, key, detail) {
  failures.push(`[${locale}] ${key}: ${detail}`);
}

if (!existsSync(LOCALES_DIR)) {
  console.error('✖ no _locales directory found');
  process.exit(1);
}

const locales = readdirSync(LOCALES_DIR);
if (locales.length === 0) {
  console.error('✖ _locales contains no locale directories');
  process.exit(1);
}

for (const locale of locales) {
  const catalogPath = join(LOCALES_DIR, locale, 'messages.json');
  if (!existsSync(catalogPath)) {
    fail(locale, '(catalog)', 'missing messages.json');
    continue;
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    fail(locale, '(catalog)', `is not JSON — ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  for (const [key, entry] of Object.entries(catalog)) {
    if (typeof entry !== 'object' || entry === null) {
      fail(locale, key, 'entry is not an object');
      continue;
    }
    const message = entry['message'];
    if (typeof message !== 'string' || message === '') {
      fail(locale, key, 'has no message');
      continue;
    }

    const placeholders = entry['placeholders'];
    if (placeholders !== undefined && (typeof placeholders !== 'object' || placeholders === null)) {
      fail(locale, key, 'placeholders is not an object');
      continue;
    }
    const declared = new Map(
      Object.entries(placeholders ?? {}).map(([name, spec]) => [
        name.toLowerCase(),
        spec && typeof spec === 'object' ? spec['content'] : undefined,
      ]),
    );

    for (const match of message.matchAll(VARIABLE)) {
      const name = match[1];
      // `$1`…`$9` are Chrome's positional slots and are legitimate in a
      // message body without a declaration; anything else must be declared.
      if (/^[1-9]$/.test(name)) continue;
      const content = declared.get(name.toLowerCase());
      if (content === undefined) {
        fail(locale, key, `uses $${name}$ but declares no placeholder for it — Chrome refuses the whole extension over this`);
      } else if (typeof content !== 'string' || !/^\$[1-9]$/.test(content)) {
        fail(locale, key, `declares $${name}$ with content ${JSON.stringify(content)}, expected "$N"`);
      }
    }

    if (placeholders !== undefined) {
      const contents = Object.values(placeholders)
        .map((spec) => (spec && typeof spec === 'object' ? spec['content'] : undefined))
        .filter((content) => typeof content === 'string')
        .map((content) => Number(content.slice(1)));
      const expected = contents.map((_, index) => index + 1);
      // The convention, not Chrome's requirement: every existing entry maps
      // its placeholders to $1..$N in declaration order, and `message()` in
      // lib/platform/i18n.ts passes a positional array. A message whose
      // placeholders skip or reorder positions would substitute the wrong
      // parameter with no error anywhere — a silent wrong-string bug this
      // catches at gate speed.
      if (contents.some((value, index) => value !== expected[index])) {
        fail(locale, key, `placeholder contents ${contents.join(', ')} are not $1..$${contents.length} in order`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ ${failures.length} catalog problem(s) — Chrome refuses to load the extension over the first of these:`);
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log(`✔ i18n catalog well-formed: ${locales.join(', ')} — every $VARIABLE$ declared, positions contiguous`);
