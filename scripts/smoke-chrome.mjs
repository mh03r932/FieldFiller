#!/usr/bin/env node
/**
 * Loads the built Chromium package in a real Chrome and asserts the extension
 * came up: the background service worker registered, the manifest was accepted,
 * the i18n substitutions resolved, and the page agent was injected into a page.
 *
 * Drives Chrome over the DevTools protocol using Node's built-in WebSocket.
 * Playwright is present as a browser fetcher but not as a driver: it cannot test
 * Firefox extensions at all, so a harness built on it would leave half of
 * NFR-017's promise unverified. `e2e-chrome.mjs` is the counterpart that asserts
 * a real fill.
 *
 * What it proves is narrow and worth having: an unloadable manifest is the single
 * most likely way this prototype is broken, and it is invisible to `wxt build`.
 * DD-007 already produced one — Chrome rejects a `Semicolon` command key at load
 * time, and the build is perfectly happy to emit it.
 *
 * Usage: node scripts/smoke-chrome.mjs   (after `pnpm run build`)
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window, for debugging this script
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

/** One of the ids `registerContextMenus` creates — see the menu probe below. */
const MENU_PROBE_ID = 'all-inputs';

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-smoke-'));
const failures = [];
let chrome;
let cdp;

// A real http origin. Content scripts matching `<all_urls>` are not injected into
// `data:` or `about:` pages, so testing against one of those would report a
// missing agent that is in fact present — a false failure that would send the
// next person hunting through the manifest.
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>smoke</title><form><input name="email"></form>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));

  // 1. The background service worker registered. If the manifest had been
  //    rejected — an illegal command key, an unknown permission — there would be
  //    no such target at all.
  //    Polled rather than read once: an MV3 service worker is started by an
  //    event, not by installation completing, so a single enumeration races the
  //    `onInstalled` startup and reports a healthy extension as a rejected one.
  //    This is the same laziness NFR-027 budgets 400 ms of cold start for.
  let worker;
  for (let attempt = 0; attempt < 60 && worker === undefined; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    worker = targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
    );
    if (worker === undefined) await sleep(100);
  }

  if (worker === undefined) {
    failures.push(
      `no service worker for extension ${extensionId} — the manifest was rejected or the background failed to register`,
    );
  } else {
    console.log(`✔ background service worker registered (${extensionId})`);

    // 2. The manifest loaded *and* its i18n substitutions resolved. A missing
    //    catalog key leaves the literal "__MSG_extName__" as the extension's
    //    name: it loads without complaint and looks broken to every user
    //    (NFR-018). Also confirms MV3 on this target (C-001) and that the three
    //    commands and the toolbar action survived load (FR-004, FR-005).
    const session = await cdp.attach(worker.targetId);
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const manifest = chrome.runtime.getManifest();
          return JSON.stringify({
            name: manifest.name,
            manifestVersion: manifest.manifest_version,
            commands: Object.keys(manifest.commands ?? {}),
            hasAction: manifest.action !== undefined,
            permissions: manifest.permissions ?? [],
            lastError: chrome.runtime.lastError?.message ?? null,
          });
        })()`,
        returnByValue: true,
      },
      session,
    );
    const state = JSON.parse(evaluated.result.value);

    if (state.name.startsWith('__MSG_')) {
      failures.push(`extension name did not resolve from the i18n catalog: ${state.name}`);
    } else {
      console.log(`✔ name resolved from the catalog: "${state.name}" (MV${state.manifestVersion})`);
    }
    if (state.manifestVersion !== 3) failures.push(`expected MV3, loaded MV${state.manifestVersion}`);
    if (!state.hasAction) failures.push('no toolbar action in the loaded manifest (FR-004)');

    // DD-007, checked against what Chrome actually *bound* rather than what the
    // manifest asked for. `commands.getAll` is the same source the browser's
    // shortcuts page reads, and the two can disagree: a suggested key that is
    // illegal, or already claimed by another extension, is dropped silently and
    // leaves the manifest looking perfectly correct.
    //
    // The expected shortcut is matched loosely because the string is formatted
    // per platform in two dimensions. The *modifiers* differ — "⇧⌘Y" on macOS,
    // "Ctrl+Shift+Y" elsewhere — and so does the *key name*: a non-letter key is
    // reported as its glyph on macOS ("⌘⇧.") but as its name on Linux and
    // Windows ("Ctrl+Shift+Period"). Measured on the Chrome for Testing build
    // this harness pins, on both platforms. Letters have no separate name,
    // which is why "Y" needs no alternatives and "Period" does. What matters is
    // which scopes are bound and which is deliberately not.
    const bound = await cdp.send(
      'Runtime.evaluate',
      { expression: 'chrome.commands.getAll().then(JSON.stringify)', awaitPromise: true, returnByValue: true },
      session,
    );
    const commands = new Map(
      JSON.parse(bound.result.value).map((command) => [command.name, command.shortcut ?? '']),
    );

    // `endsWith` is one acceptable suffix or several; the assertion passes if
    // any of them matches. `null` keeps its meaning: deliberately unbound.
    const expected = [
      { name: 'fill-all-inputs', endsWith: ['Y'], note: 'bound by DD-007' },
      { name: 'fill-current-form', endsWith: ['.', 'Period'], note: 'bound by DD-007, Period substituted for the illegal Semicolon' },
      // Not an oversight: DD-007 ships this scope unbound, because the control
      // is most naturally reached by right-clicking the field itself. UC-030 is
      // how the user discovers it can be bound at all — so a shortcut appearing
      // here would mean the decision had been quietly reversed.
      { name: 'fill-selected-input', endsWith: null, note: 'deliberately unbound' },
    ];

    for (const { name, endsWith, note } of expected) {
      const shortcut = commands.get(name);
      if (shortcut === undefined) {
        failures.push(`command "${name}" is missing from the loaded extension`);
      } else if (endsWith === null) {
        if (shortcut !== '') failures.push(`"${name}" is bound to ${shortcut}, but DD-007 ships it unbound`);
        else console.log(`✔ ${name}: unbound (${note})`);
      } else if (shortcut === '') {
        failures.push(`"${name}" has no shortcut — Chrome dropped the suggested key (${note})`);
      } else if (!endsWith.some((suffix) => shortcut.endsWith(suffix))) {
        failures.push(
          `"${name}" is bound to ${shortcut}, expected a binding ending in "${endsWith.join('" or "')}"`,
        );
      } else {
        console.log(`✔ ${name}: ${shortcut} (${note})`);
      }
    }
    if (state.lastError !== null) failures.push(`runtime.lastError after startup: ${state.lastError}`);

    // NFR-008 is a ceiling, not a floor: anything beyond the permitted five is a
    // regression, and the manifest is the only place it can be checked honestly.
    const allowed = new Set(['storage', 'contextMenus', 'scripting', 'activeTab']);
    const extra = state.permissions.filter((permission) => !allowed.has(permission));
    if (extra.length > 0) failures.push(`permissions beyond NFR-008: ${extra.join(', ')}`);
    else console.log(`✔ permissions within NFR-008: ${state.permissions.join(', ')}`);

    // The context menus actually registered (FR-006). There is no API that lists
    // menu items, so this probes by trying to create one that should already
    // exist: a duplicate id is refused, and that refusal is the evidence. A
    // clean creation means `onInstalled` never got as far as registering.
    //
    // Worth asserting rather than assuming, because the failure it catches is
    // silent — a throw inside an `onInstalled` listener leaves the menus absent
    // and logs nothing, so the only symptom is an empty right-click menu.
    const probe = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `new Promise((resolve) => {
          chrome.contextMenus.create(
            { id: ${JSON.stringify(MENU_PROBE_ID)}, title: 'probe', contexts: ['page'] },
            () => resolve(chrome.runtime.lastError?.message ?? 'created'),
          );
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      session,
    );
    if (/duplicate/i.test(probe.result.value)) {
      console.log(`✔ context menus registered (id "${MENU_PROBE_ID}" already taken)`);
    } else {
      failures.push(
        `context menu "${MENU_PROBE_ID}" was not registered — creating it succeeded (${probe.result.value})`,
      );
    }
  }

  // 3. The page agent is injected. Its isolated world appears as a separate
  //    execution context on the page target, carrying the extension's origin —
  //    which is how a content script is observable without it touching the page.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const pageSession = await cdp.attach(targetId);
  await cdp.send('Runtime.enable', {}, pageSession);
  await cdp.send('Page.enable', {}, pageSession);
  await cdp.send('Page.navigate', { url: pageUrl }, pageSession);

  // Content scripts run at document_idle. Poll rather than sleep once, so a slow
  // machine reports the truth instead of a timing artefact.
  let isolatedWorld;
  for (let attempt = 0; attempt < 40 && isolatedWorld === undefined; attempt++) {
    await sleep(100);
    isolatedWorld = cdp.events
      .filter((event) => event.method === 'Runtime.executionContextCreated')
      .map((event) => event.params.context)
      .find((context) => context.origin.includes(extensionId));
  }

  if (isolatedWorld === undefined) {
    failures.push(`no execution context for ${extensionId} on ${pageUrl} — the page agent was not injected`);
  } else {
    console.log(`✔ page agent injected into ${pageUrl} (isolated world "${isolatedWorld.name}")`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  server.close();

  if (chrome !== undefined) {
    chrome.kill();
    // Chrome is still flushing its profile when `kill` returns, so removing the
    // directory immediately fails with ENOTEMPTY — and failing *there* would
    // report a passing smoke test as broken. Wait for the exit, then clean up on
    // a best-effort basis: a leftover temp directory is not a test result.
    await Promise.race([
      new Promise((resolve) => chrome.once('exit', resolve)),
      sleep(5000),
    ]);
  }

  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`  (left a temp profile behind: ${profileDir})`);
  }
}

if (failures.length > 0) {
  console.error('\n✖ Chromium smoke test failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log('\n✔ the extension loads and runs in Chromium');
