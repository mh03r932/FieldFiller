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
    'exec', 'web-ext', 'submit',
    '--source-dir', SOURCE_DIR,
    '--channel', 'listed',
    '--upload-source-file', SOURCES_ZIP,
    '--no-input',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
