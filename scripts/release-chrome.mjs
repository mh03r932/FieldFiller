#!/usr/bin/env node
/**
 * Uploads the Chromium package to the Chrome Web Store with
 * `chrome-webstore-upload`, the official CLI — publish included, so a release
 * is one command once the credentials exist.
 *
 * The API can only update an item that already exists. The first submission is
 * a manual one at https://chromewebstore.google.com/devconsole (+ New item);
 * from then on this script owns every update. Set EXTENSION_ID from the item's
 * devconsole URL (`.../edit/<32 letters>`).
 *
 * Credentials (one-time; https://developer.chrome.com/docs/webstore/using-webstore-api):
 *   EXTENSION_ID   the item's 32-letter id
 *   CLIENT_ID      OAuth client id — a GCP project with the Chrome Web Store
 *                  API enabled, and an OAuth client of type "Desktop app"
 *   CLIENT_SECRET  that client's secret
 *   REFRESH_TOKEN  from the OAuth consent flow against that client, scope
 *                  https://www.googleapis.com/auth/chromewebstore
 *
 * Usage: pnpm zip && pnpm release:chrome
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ZIP = join(ROOT, '.output', `fieldfiller-${version}-chrome.zip`);

if (!existsSync(ZIP)) {
  console.error(`✖ ${ZIP} not found. Run \`pnpm zip\` first.`);
  process.exit(1);
}
if (process.env['EXTENSION_ID'] === undefined) {
  console.error(
    '✖ EXTENSION_ID is not set.\n' +
      '    If the item does not exist yet, create it once by hand at\n' +
      '    https://chromewebstore.google.com/devconsole — the API cannot make the\n' +
      '    first submission. Then set EXTENSION_ID to the 32-letter id in its URL.',
  );
  process.exit(1);
}
for (const name of ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']) {
  if (process.env[name] === undefined) {
    console.error(
      `✖ ${name} is not set. See the header of this script for the one-time setup.`,
    );
    process.exit(1);
  }
}

console.log(`Uploading FieldFiller ${version} to the Chrome Web Store and publishing…`);
const result = spawnSync(
  'pnpm',
  ['exec', 'chrome-webstore-upload', '--zip', ZIP, '--publish', 'true'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
