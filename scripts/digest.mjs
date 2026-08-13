#!/usr/bin/env node
/**
 * Publishes the SHA-256 of every distributable artefact (G4, NFR-011, UC-032).
 *
 * This is the user-facing half of the verifiable-build claim: CI attaches this
 * output to the release, an auditor rebuilds the tagged source, and the digests
 * either match or they do not. Writing it to a file rather than only to the log
 * makes it an artefact that can be attached and quoted.
 *
 * Usage: node scripts/digest.mjs   (after `pnpm run zip:all`)
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, '.output');

if (!existsSync(OUTPUT_DIR)) {
  console.error('✖ no .output directory. Run `pnpm run zip:all` first.');
  process.exit(1);
}

const zips = readdirSync(OUTPUT_DIR)
  .filter((name) => name.endsWith('.zip'))
  .sort();

if (zips.length === 0) {
  console.error('✖ no .zip artefacts in .output. Run `pnpm run zip:all` first.');
  process.exit(1);
}

const lines = zips.map((name) => {
  const digest = createHash('sha256').update(readFileSync(join(OUTPUT_DIR, name))).digest('hex');
  return `${digest}  ${name}`;
});

const report = `${lines.join('\n')}\n`;
writeFileSync(join(OUTPUT_DIR, 'SHA256SUMS'), report);
process.stdout.write(report);
