#!/usr/bin/env node
/**
 * Submits the Firefox package to AMO with `web-ext`, the official tool, so a
 * release is one command rather than a dashboard session.
 *
 * Everything the stores need is already built — this only resolves names and
 * refuses early. The package comes from `.output/firefox-mv3` (web-ext zips
 * the directory itself), and the sources zip AMO requires for bundled code is
 * the one WXT laid next to it.
 *
 * The command is `sign`, though the script was first written against `submit`:
 * web-ext removed `submit` after v8 and folded its job into `sign`, which then
 * drove the submission API — `--channel` became required, and the sources
 * archive moved from `--upload-source-file` to `--upload-source-code`. The
 * lockfile is on web-ext 10, where the old spelling no longer exists, and
 * release v0.1.1's first pipeline run died on exactly that. `sign` is the
 * spelling that reads: for a listed add-on it creates the listing or adds the
 * version, which is what a release is.
 *
 * `--approval-timeout 0` keeps this script's contract honest: it submits and
 * returns, and does not wait out a human review that can take days. The CI job
 * holding it has fifteen minutes; the review queue lives in the AMO dashboard,
 * not in a command's exit status.
 *
 * Credentials (https://addons.mozilla.org/developers/addon/api/key/):
 *   WEB_EXT_API_KEY     the "JWT issuer" key
 *   WEB_EXT_API_SECRET  the "JWT secret"
 *
 * Usage: pnpm zip:firefox && pnpm release:firefox
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, '.output', 'firefox-mv3');

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SOURCES_ZIP = join(ROOT, '.output', `fieldfiller-${version}-sources.zip`);

if (!existsSync(join(SOURCE_DIR, 'manifest.json'))) {
  console.error('✖ no Firefox build found. Run `pnpm zip:firefox` first.');
  process.exit(1);
}
if (!existsSync(SOURCES_ZIP)) {
  console.error(`✖ ${SOURCES_ZIP} not found. Run \`pnpm zip:firefox\` first.`);
  process.exit(1);
}
for (const name of ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']) {
  if (process.env[name] === undefined) {
    console.error(
      `✖ ${name} is not set. Create a key at https://addons.mozilla.org/developers/addon/api/key/ ` +
        'and export both halves of it.',
    );
    process.exit(1);
  }
}

console.log(`Submitting FieldFiller ${version} to AMO (listed channel)…`);
const result = spawnSync(
  'pnpm',
  [
    'exec', 'web-ext', 'sign',
    '--source-dir', SOURCE_DIR,
    '--channel', 'listed',
    '--upload-source-code', SOURCES_ZIP,
    '--approval-timeout', '0',
    '--no-input',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
