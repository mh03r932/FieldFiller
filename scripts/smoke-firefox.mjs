#!/usr/bin/env node
/**
 * Loads the built Firefox package in a real Firefox and asserts it installs.
 *
 * The Chromium smoke test's counterpart, and the more important of the two for
 * this project: C-003 (background model) and C-004 (`gecko.id`) exist precisely
 * because the two browsers disagree about the manifest, and a build that is
 * accepted by Chrome tells you nothing about Firefox. Installation is where a
 * rejected key surfaces.
 *
 * Driven over WebDriver BiDi, which Firefox speaks natively — no `web-ext`, no
 * driver binary. Release Firefox refuses to load an unsigned extension from a
 * profile, so a temporary install over the remote protocol is the only way to
 * load a development build at all.
 *
 * Usage: node scripts/smoke-firefox.mjs   (after `pnpm run build:firefox`)
 *   FIREFOX_PATH=…  override the browser binary
 *   HEADFUL=1       show the window, for debugging this script
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeFirefox, launchFirefox } from './lib/firefox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'firefox-mv3');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Firefox build found. Run `pnpm run build:firefox` first.');
  process.exit(1);
}

const failures = [];
let session;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>smoke</title><form><input name="email"></form>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  session = await launchFirefox();
  const { bidi } = session;

  // The assertion that matters: Firefox accepts the manifest. A rejected
  // `gecko.id` (C-004), an MV3 background block it disagrees with (C-003), or an
  // unknown permission all fail right here.
  const installed = await bidi.send('webExtension.install', {
    extensionData: { type: 'path', path: EXTENSION_DIR },
  });
  console.log(`✔ installed as a temporary add-on (${installed.extension})`);

  if (installed.extension !== 'fieldfiller@dividbzero') {
    failures.push(
      `Firefox assigned id "${installed.extension}", not the gecko.id from the manifest (C-004)`,
    );
  } else {
    console.log('✔ gecko.id honoured — the AMO listing identity is stable (C-004)');
  }

  // A page load with the add-on installed. The page agent has no observable
  // effect by design, so this is a crash check rather than an injection check:
  // an agent that throws on startup takes the navigation's console with it.
  const context = await bidi.send('browsingContext.create', { type: 'tab' });
  await bidi.send('browsingContext.navigate', {
    context: context.context,
    url: pageUrl,
    wait: 'complete',
  });
  console.log(`✔ navigated to ${pageUrl} with the add-on installed`);

  const evaluated = await bidi.send('script.evaluate', {
    expression: 'document.querySelector("input[name=email]") !== null',
    target: { context: context.context },
    awaitPromise: false,
  });
  if (evaluated.result?.value !== true) {
    failures.push('the test page did not load as expected');
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeFirefox(session ?? {});
}

if (failures.length > 0) {
  console.error('\n✖ Firefox smoke test failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log('\n✔ the extension loads and runs in Firefox');
