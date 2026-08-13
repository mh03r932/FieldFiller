#!/usr/bin/env node
/**
 * NFR-011 / G4: building the tagged source must produce a package whose SHA-256
 * matches the published artefact. This proves the property by doing it — two
 * clean builds from the same tree, digests compared.
 *
 * The plan (Phase 0) expected to fight the bundler for this: embedded
 * timestamps, archive members ordered by filesystem enumeration, unstable
 * minification. Measured instead: WXT sorts the archive's file list explicitly
 * and writes every entry with the zeroed 1980 DOS epoch, so both hazards are
 * already handled upstream, and `SOURCE_DATE_EPOCH` has nothing to act on
 * because no build timestamp is embedded in the first place.
 *
 * That makes this script the load-bearing part rather than a formality: the
 * property currently holds because of a dependency's internals, and this is what
 * notices if an upgrade changes them. Determinism you have not re-verified since
 * the last dependency bump is a claim, not a property.
 *
 * What it cannot prove: that a *different machine* produces the same bytes. Same
 * lockfile, same Node major and same pnpm version are the assumptions, which is
 * why CI pins all three and is the reference environment for the published
 * digest.
 *
 * Usage: node scripts/check-reproducible.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, '.output');

function buildAndDigest(label) {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log(`  building (${label})…`);
  execFileSync('pnpm', ['run', 'zip:all'], { cwd: ROOT, stdio: 'pipe' });

  const digests = new Map();
  for (const name of readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.zip')).sort()) {
    digests.set(name, createHash('sha256').update(readFileSync(join(OUTPUT_DIR, name))).digest('hex'));
  }
  if (digests.size === 0) throw new Error('no .zip artefacts were produced');
  return digests;
}

console.log('Verifying reproducibility (NFR-011): two clean builds, digests compared.');
const first = buildAndDigest('first');
const second = buildAndDigest('second');

const names = new Set([...first.keys(), ...second.keys()]);
const mismatches = [];

for (const name of [...names].sort()) {
  const a = first.get(name);
  const b = second.get(name);
  if (a === undefined || b === undefined) {
    mismatches.push(`${name}: produced by only one of the two builds`);
  } else if (a !== b) {
    mismatches.push(`${name}:\n      build 1 ${a}\n      build 2 ${b}`);
  } else {
    console.log(`  ✔ ${name} ${a}`);
  }
}

if (mismatches.length > 0) {
  console.error(`\n✖ build is not reproducible: ${mismatches.length} artefact(s) differ\n`);
  for (const mismatch of mismatches) console.error(`    ${mismatch}`);
  console.error(
    '\n  G4 promises anyone can check sha256(store build) == sha256(release build).\n' +
      '  Look for a build-time clock, a random value, or an unsorted archive listing.',
  );
  process.exit(1);
}

if (!existsSync(join(OUTPUT_DIR, 'chrome-mv3'))) {
  console.error('✖ the second build left no chrome-mv3 output behind.');
  process.exit(1);
}

console.log('\n✔ reproducible: both builds produced byte-identical artefacts');
