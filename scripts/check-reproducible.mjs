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

/**
 * Every target that must appear in a build, as a suffix of its zip's filename.
 *
 * Named explicitly because equality is not enough on its own: two builds that
 * both fail to emit the Firefox package agree perfectly, and a gate comparing
 * only what it finds would call that reproducible. Absence has to be an error in
 * its own right, or the check passes most confidently at the moment it has least
 * to compare (the same false-pass the size gate guards against when a manifest
 * declares no content script).
 */
const REQUIRED_TARGETS = ['-chrome.zip', '-firefox.zip'];

function buildAndDigest(label) {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log(`  building (${label})…`);

  try {
    // `shell` on Windows, where pnpm resolves to pnpm.cmd and execFileSync cannot
    // spawn it directly. CI is Ubuntu; this keeps local runs working on Windows.
    execFileSync('pnpm', ['run', 'zip:all'], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // Node does append the captured output to `error.message`, so the build's
    // own error is not lost — but an uncaught throw prints it wrapped in a stack
    // trace through this file, which is never the interesting part. A failing
    // build should read as a failing build.
    console.error(`\n✖ the ${label} build failed:\n`);
    for (const [stream, content] of [['stdout', error.stdout], ['stderr', error.stderr]]) {
      const text = String(content ?? '').trim();
      if (text !== '') console.error(`  --- ${stream} ---\n${text}\n`);
    }
    process.exit(1);
  }

  const digests = new Map();
  for (const name of readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.zip')).sort()) {
    digests.set(name, createHash('sha256').update(readFileSync(join(OUTPUT_DIR, name))).digest('hex'));
  }

  const missing = REQUIRED_TARGETS.filter(
    (suffix) => ![...digests.keys()].some((name) => name.endsWith(suffix)),
  );
  if (missing.length > 0) {
    // Printed and exited rather than thrown, for the same reason the build
    // failure above is: an uncaught throw wraps the message in a stack trace
    // through this file, and the stack is never the interesting part. This path
    // had been left throwing while the other was fixed — the inconsistency was
    // the bug.
    console.error(`\n✖ the ${label} build produced no package for: ${missing.join(', ')}`);
    console.error(`  found: ${digests.size > 0 ? [...digests.keys()].join(', ') : 'nothing'}\n`);
    console.error('  Both targets must ship, or "reproducible" is a claim about half a release.');
    process.exit(1);
  }
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

// The second build is the one CI goes on to publish, so both unpacked outputs
// have to survive this script rather than only the one that happens to be first.
for (const target of ['chrome-mv3', 'firefox-mv3']) {
  if (!existsSync(join(OUTPUT_DIR, target))) {
    console.error(`✖ the second build left no ${target} output behind.`);
    process.exit(1);
  }
}

console.log('\n✔ reproducible: both builds produced byte-identical artefacts');
