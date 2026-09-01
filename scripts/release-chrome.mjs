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
 *   PUBLISHER_ID   the publishing *account's* id, not the item's — devconsole
 *                  → Publisher → Settings displays it. It is also the segment
 *                  after `/devconsole/` in the dashboard URL, but read it from
 *                  Settings: an account publishing under a group publisher has
 *                  a publisher id that is not its own account id, and only
 *                  Settings distinguishes the two. Account-level, like the
 *                  three below: every item this account publishes shares it.
 *   CLIENT_ID      OAuth client id — a GCP project with the Chrome Web Store
 *                  API enabled, and an OAuth client of type "Desktop app"
 *   CLIENT_SECRET  that client's secret
 *   REFRESH_TOKEN  from the OAuth consent flow against that client, scope
 *                  https://www.googleapis.com/auth/chromewebstore
 *
 * PUBLISHER_ID is not optional and not historical: this CLI addresses the v2
 * API, where an item is named `publishers/<id>/items/<id>` rather than by its
 * extension id alone. Leaving it unset reaches the store as `Option
 * "publisherId" is required`, thrown before the first request — which is how
 * v0.1.3's release ended.
 *
 * The CLI's upload-and-publish is its default — invoking it with no subcommand
 * does both — so the only argument this passes is `--source`, naming the zip.
 * The interface was not always so spare: v0.1.2's pipeline run passed `--zip`
 * and `--publish`, flags this CLI has never known, and it silently ignored
 * both before dying looking for a manifest.json in the repo root. Silence on
 * an unknown flag is why the invocation names nothing it does not need.
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
if ((process.env['EXTENSION_ID'] ?? '') === '') {
  console.error(
    '✖ EXTENSION_ID is not set.\n' +
      '    If the item does not exist yet, create it once by hand at\n' +
      '    https://chromewebstore.google.com/devconsole — the API cannot make the\n' +
      '    first submission. Then set EXTENSION_ID to the 32-letter id in its URL.',
  );
  process.exit(1);
}
// Empty counts as unset. A workflow that names a secret the repository does
// not have exports the variable anyway, with an empty value — so a `=== undefined`
// test would wave the run through to fail inside the CLI instead, one layer
// further from the secret that is actually missing.
for (const name of ['PUBLISHER_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']) {
  if ((process.env[name] ?? '') === '') {
    console.error(
      `✖ ${name} is not set. See the header of this script for the one-time setup.`,
    );
    process.exit(1);
  }
}

console.log(`Uploading FieldFiller ${version} to the Chrome Web Store and publishing…`);
const result = spawnSync(
  'pnpm',
  ['exec', 'chrome-webstore-upload', '--source', ZIP],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
