#!/usr/bin/env node
/**
 * Loads the built Chromium package in a real Chrome and asserts the extension
 * came up: the background service worker registered, the manifest was accepted,
 * the i18n substitutions resolved, and the page agent was injected into a page.
 *
 * Dependency-free on purpose — it drives Chrome over the DevTools protocol using
 * Node's built-in WebSocket. A browser automation framework is the right tool for
 * Phase 1, where there is a fill to assert against a reference page (NFR-014);
 * pulling one in now, to check that a no-op extension loads, would be a large
 * dependency serving a small claim.
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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One of the ids `registerContextMenus` creates — see the menu probe below. */
const MENU_PROBE_ID = 'all-inputs';

/**
 * A free port, picked per run rather than fixed — a browser that outlived a
 * previous run would otherwise be found on a fixed port and quietly tested in
 * place of the build on disk.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function findChrome() {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error('No Chrome or Chromium found. Set CHROME_PATH to the executable.');
  }
  return found;
}

/**
 * Chrome derives an unpacked extension's id from the absolute path it was loaded
 * from: the first 32 hex digits of its SHA-256, with 0–f mapped onto a–p. Knowing
 * the id up front is what lets this script pick our service worker out of the
 * list — Chrome loads its own component extensions regardless of
 * `--disable-extensions-except`, and two of them also have a `background.js`.
 */
function derivedExtensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

async function browserWebSocketUrl(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(150);
  }
  throw new Error('Chrome did not open a DevTools port in time');
}

/**
 * Minimal CDP client with flat session support. Sessions are needed because
 * service-worker targets are only reachable through the browser-level endpoint —
 * `/json/list` reports pages and never workers, which is quietly misleading if
 * you use it to decide whether an extension loaded.
 */
async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`CDP connection failed: ${url}`)));
  });

  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id !== undefined) {
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    } else {
      events.push(frame);
    }
  });

  return {
    events,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (frame) => {
          if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
          else resolve(frame.result);
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async attach(targetId) {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      return sessionId;
    },
    close() {
      socket.close();
    },
  };
}

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
  const debugPort = await freePort();
  chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      // Extensions require the new headless mode; the old one ignored them.
      ...(process.env['HEADFUL'] === '1' ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  cdp = await connect(await browserWebSocketUrl(debugPort));

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
    if (state.commands.length !== 3) {
      failures.push(`expected 3 commands, Chrome accepted ${state.commands.length}: ${state.commands.join(', ')}`);
    } else {
      console.log(`✔ commands accepted: ${state.commands.join(', ')}`);
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
