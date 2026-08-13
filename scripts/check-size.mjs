#!/usr/bin/env node
/**
 * NFR-003: the page agent must not exceed 40 KB minified and uncompressed.
 *
 * DD-001 injects the agent into every frame of every page, which makes this the
 * most load-bearing budget in the project — it is a permanent tax on the user's
 * browsing, and it is the reason persistent injection is defensible at all. G6
 * quotes the number publicly (40 KB against the reference's 480 KB), so the gate
 * is what keeps a marketing claim true.
 *
 * Uncompressed is the metric on purpose. An extension bundle is read from disk,
 * never transferred, so parse and compile cost scales with uncompressed bytes;
 * gzipped size would flatter us and measure nothing the user experiences.
 *
 * Measures every file the manifest actually loads into the page — all
 * `content_scripts` JS and CSS together — rather than one filename, so splitting
 * the agent across chunks cannot route around the budget.
 *
 * Usage: node scripts/check-size.mjs   (after `pnpm run build:all`)
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, '.output');
const TARGETS = ['chrome-mv3', 'firefox-mv3'];
const BUDGET_BYTES = 40 * 1024;

/** Files a content_scripts entry pulls into the page, as manifest-relative paths. */
function pageAgentFiles(manifest) {
  const files = [];
  for (const script of manifest.content_scripts ?? []) {
    files.push(...(script.js ?? []), ...(script.css ?? []));
  }
  return files;
}

let failed = false;

for (const target of TARGETS) {
  const targetDir = join(OUTPUT_DIR, target);
  const manifestPath = join(targetDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    console.error(`✖ ${target}: no build found. Run \`pnpm run build:all\` first.`);
    failed = true;
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = pageAgentFiles(manifest);

  if (files.length === 0) {
    // Not a pass. An agent that ships nothing cannot fill anything, and a build
    // that silently dropped the content script would otherwise read as 0 bytes
    // and sail through the tightest budget in the project.
    console.error(`✖ ${target}: manifest declares no content script — the page agent is missing.`);
    failed = true;
    continue;
  }

  let total = 0;
  const breakdown = [];
  for (const file of files) {
    const size = statSync(join(targetDir, file)).size;
    total += size;
    breakdown.push(`${file} ${(size / 1024).toFixed(2)} KB`);
  }

  const used = ((total / BUDGET_BYTES) * 100).toFixed(1);
  const line = `${target}: ${(total / 1024).toFixed(2)} KB of 40 KB (${used}%) — ${breakdown.join(', ')}`;

  if (total > BUDGET_BYTES) {
    console.error(`✖ ${line}`);
    console.error('  NFR-003 exceeded. The page agent runs in every frame of every page (DD-001).');
    failed = true;
  } else {
    console.log(`✔ ${line}`);
  }
}

process.exit(failed ? 1 : 0);
