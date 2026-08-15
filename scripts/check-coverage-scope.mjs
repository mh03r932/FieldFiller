#!/usr/bin/env node
/**
 * NFR-012's floor is enforced by globbed thresholds in `vitest.config.ts`, and
 * the CI comment beside them used to claim the floor "grows with the engine
 * rather than quietly excusing everything added later". That was a convention,
 * not a mechanism: coverage *measures* `src/lib/**`, but only the files matched
 * by a threshold glob are *held to* anything. A new area under `src/lib` — as
 * `platform/` already was — appeared in the report and was gated by nothing, and
 * the only thing standing between that and an unnoticed hole was somebody
 * remembering to add a glob in the same change.
 *
 * Nobody remembered. When this gate was first run it found `src/lib/settings.ts`
 * — DD-005's schema, including the tolerant `parseSettings` whose failure mode
 * is silently discarding a user's rules — sitting at 62% lines, under no glob,
 * having been added a day earlier.
 *
 * So: every file coverage includes must be matched by a threshold glob, or be on
 * ALLOWED_UNGATED with a reason. Adding an area under `src/lib` now forces the
 * choice at the moment it is made, which is the only moment anyone has the
 * context to make it.
 *
 * This reads `vitest.config.ts` as text rather than importing it, because the
 * config is TypeScript and this gate is plain Node. That makes the parse the
 * fragile part, so it is written to fail loudly: a config whose shape this
 * script cannot recognise is an error, never a pass. A gate that goes quiet
 * when its input changes is worse than no gate, because it still reads green.
 *
 * Usage: node scripts/check-coverage-scope.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'vitest.config.ts');

/**
 * Files coverage measures but no threshold gates, each with the reason it is
 * exempt rather than merely absent. The distinction this list exists to make is
 * between code nobody has gotten to and code a floor would not improve.
 */
const ALLOWED_UNGATED = new Map([
  [
    'src/lib/platform/i18n.ts',
    'A wrapper over `browser.i18n.getMessage`. Covering it means asserting ' +
      'against a mock of the browser API, which tests the mock.',
  ],
  [
    'src/lib/platform/settings-store.ts',
    'A wrapper over `browser.storage.local`. Same argument — and what it ' +
      'reads and writes is `parseSettings`, which is gated.',
  ],
]);

const config = readFileSync(CONFIG, 'utf8');

/** Both extractions are anchored on the key name and fail rather than guess. */
const includes = arrayAfter('include:');
const globs = thresholdKeys();

/**
 * The `include` array, e.g. `include: ['src/lib/**'],`.
 *
 * Anchored to the `coverage` block by taking the first `include:` that follows
 * it, so the `test.include` array of test files above cannot be picked up by
 * mistake.
 */
function arrayAfter(key) {
  const coverage = config.indexOf('coverage: {');
  if (coverage === -1) fail('no `coverage: {` block found in vitest.config.ts');

  const at = config.indexOf(key, coverage);
  if (at === -1) fail(`no \`${key}\` found inside the coverage block`);

  const open = config.indexOf('[', at);
  const close = config.indexOf(']', open);
  if (open === -1 || close === -1) fail(`\`${key}\` is not followed by an array literal`);

  const entries = [...config.slice(open, close).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (entries.length === 0) fail(`\`${key}\` is an empty array`);
  return entries;
}

/** The quoted keys of the `thresholds` object, e.g. `'src/lib/page/**': {…}`. */
function thresholdKeys() {
  const at = config.indexOf('thresholds: {');
  if (at === -1) fail('no `thresholds: {` block found in vitest.config.ts');

  const keys = [...config.slice(at).matchAll(/'([^']+)':\s*\{/g)].map((match) => match[1]);
  if (keys.length === 0) fail('the `thresholds` block declares no globbed keys');
  return keys;
}

/**
 * Enough glob for the shapes a threshold key takes: `**` crosses directory
 * separators, `*` does not, and everything else is literal. Deliberately not a
 * general implementation — a wrong match here would silently exempt a file,
 * so the supported syntax is the syntax the config actually uses.
 */
function matches(glob, path) {
  if (!/^[\w./*-]+$/.test(glob)) fail(`threshold glob \`${glob}\` uses syntax this gate cannot read`);

  const pattern = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${pattern}$`).test(path);
}

/** Every `.ts` file under an include root, as a repo-relative POSIX path. */
function sources(glob) {
  const root = join(ROOT, glob.replace(/\/\*+$/, ''));
  const found = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(path);
    }
  };
  walk(root);

  return found.map((path) => relative(ROOT, path).split(sep).join('/'));
}

const measured = [...new Set(includes.flatMap(sources))].sort();
const ungated = measured.filter((path) => !globs.some((glob) => matches(glob, path)));
const problems = ungated.filter((path) => !ALLOWED_UNGATED.has(path));

/** An allowlist entry for a file that no longer exists is stale, and says so. */
const stale = [...ALLOWED_UNGATED.keys()].filter((path) => !measured.includes(path));

if (problems.length > 0 || stale.length > 0) {
  console.error('\n✖ coverage scope does not match NFR-012:\n');
  for (const path of problems) {
    console.error(
      `    ${path} is measured by coverage but matched by no threshold glob.\n` +
        `      Add a glob in vitest.config.ts covering it, or add it to\n` +
        `      ALLOWED_UNGATED in this script with the reason a floor would not help.`,
    );
  }
  for (const path of stale) {
    console.error(`    ${path} is on ALLOWED_UNGATED but no longer exists. Remove the entry.`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `✔ coverage scope matches NFR-012: ${measured.length} measured file(s), ` +
    `${measured.length - ungated.length} under ${globs.length} threshold glob(s), ` +
    `${ungated.length} allowlisted`,
);
for (const [path, reason] of ALLOWED_UNGATED) console.log(`  ungated: ${path} — ${reason}`);

function fail(reason) {
  console.error(`\n✖ cannot read the coverage config: ${reason}.`);
  console.error('    This gate parses vitest.config.ts as text. If the config was');
  console.error('    restructured, update the extraction rather than removing the gate.\n');
  process.exit(1);
}
