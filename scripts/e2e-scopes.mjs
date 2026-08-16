#!/usr/bin/env node
/**
 * UC-002, UC-003 and UC-008 against a real Chromium with the extension loaded.
 *
 * The unit tests in `tests/scope.test.ts` decide whether the DD-008 ladder is
 * *correct*; this decides whether it is *reachable*. Everything between the two
 * lives outside happy-dom: the context menu's `frameId`, `chrome.tabs.get`
 * returning a URL under `activeTab`, the badge, and the fact that the agent has
 * to have seen the right-click itself because Chrome will not tell us which
 * element it was (DD-001).
 *
 * Each case reloads the fixture first. Scope is the thing under test, so a run
 * that inherited another case's writes would be scoring the wrong page — and the
 * failure would read as a scope leak, which is exactly the defect this exists to
 * catch.
 *
 * Usage: pnpm run build && pnpm run scopes:chrome
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'scopes.html');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function playwrightChromium() {
  try {
    const require = createRequire(import.meta.url);
    const path = require('playwright').chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function findChrome() {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const pinned = playwrightChromium();
  if (pinned !== undefined) return pinned;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      'No Chrome or Chromium found. Run `pnpm exec playwright install chromium`, or set CHROME_PATH.',
    );
  }
  return found;
}

function derivedExtensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`CDP connection failed: ${url}`)));
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id !== undefined) { pending.get(frame.id)?.(frame); pending.delete(frame.id); }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (frame) =>
          frame.error ? reject(new Error(`${method}: ${frame.error.message}`)) : resolve(frame.result));
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async attach(targetId) {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      return sessionId;
    },
    close() { socket.close(); },
  };
}

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-scopes-'));
let chrome;
let cdp;

const html = readFileSync(FIXTURE, 'utf8');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail });
  if (condition !== true) failures.push(`${name} — ${detail}`);
}

try {
  const debugPort = await freePort();
  chrome = spawn(findChrome(), [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    ...(process.env['HEADFUL'] === '1' ? [] : ['--headless=new']),
    ...(process.env['CI'] === undefined ? [] : ['--no-sandbox', '--disable-dev-shm-usage']),
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let attempt = 0; attempt < 100 && wsUrl === undefined; attempt++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl;
    } catch { await sleep(150); }
  }
  cdp = await connect(wsUrl);

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Runtime.enable', {}, page);

  let worker;
  for (let attempt = 0; attempt < 60 && worker === undefined; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    if (worker === undefined) await sleep(100);
  }
  if (worker === undefined) throw new Error('the background service worker never started');
  const workerSession = await cdp.attach(worker.targetId);

  const inPage = async (expression) => {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      page,
    );
    return result.value;
  };

  const inWorker = async (expression) => {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      workerSession,
    );
    return result.value;
  };

  /** Every filled control, by name — the shape every assertion below reads. */
  const filledNames = async () =>
    inPage(`[...document.querySelectorAll('input[name]')]
      .filter((input) => input.value !== '')
      .map((input) => input.name)
      .sort()`);

  async function reload() {
    await cdp.send('Page.navigate', { url: pageUrl }, page);
    await sleep(900);
  }

  /**
   * Points at a control the way a user does, then invokes a scope from the menu.
   *
   * The right-click is dispatched in the page rather than synthesised through
   * the Input domain because what matters is that the *agent* saw it: the agent
   * listens in capture on the document, and Chrome's menu callback carries no
   * element identifier for it to use instead (DD-001).
   */
  /**
   * A right-click the browser sends, at the element's own coordinates.
   *
   * Not `dispatchEvent(new MouseEvent('contextmenu'))`, which is what this used
   * to do: an event a page script dispatches carries `isTrusted === false`, and
   * the agent ignores those on purpose, so a page cannot plant the anchor a
   * later fill uses. Dispatching one here meant the harness was driving the
   * extension through an input production refuses — it passed while the guard
   * did not exist, and every rung check failed the moment it did.
   *
   * `Input.dispatchMouseEvent` goes in where a real click does, so the event is
   * trusted and the pointer path this harness exists to exercise is the path
   * that actually runs. Focusing the element instead would also have worked and
   * would have tested the wrong thing.
   */
  async function rightClick(selector) {
    const at = await inPage(`(() => {
      const element = document.querySelector('${selector}');
      if (element === null) return null;
      element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    if (at === null) throw new Error(`nothing matched ${selector} to right-click`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 },
        page,
      );
    }
  }

  async function pointAndFill(selector, menuItemId) {
    await reload();
    if (selector !== undefined) await rightClick(selector);
    const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
      if (tab === undefined) return 'no tab';
      chrome.contextMenus.onClicked.dispatch({ menuItemId: '${menuItemId}', frameId: 0 }, tab);
      return 'ok';
    }).catch((error) => 'threw: ' + error.message)`);
    if (fired !== 'ok') throw new Error(`the context menu did not fire — ${String(fired)}`);
    await sleep(1800);
  }

  const badgeTitle = async () =>
    inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.getTitle({ tabId: (tabs.find((t) => t.active) ?? tabs[0]).id }))`);

  const badgeText = async () =>
    inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.getBadgeText({ tabId: (tabs.find((t) => t.active) ?? tabs[0]).id }))`);

  // ── UC-002, rung 1: the page said so ────────────────────────────────────────
  await pointAndFill('[name="a_one"]', 'current-form');
  check('form scope fills the owning form and nothing else',
    JSON.stringify(await filledNames()) === JSON.stringify(['a_one', 'a_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002, rung 2: the author said so without a <form> ─────────────────────
  await pointAndFill('[name="b_one"]', 'current-form');
  check('form scope honours role="form" where there is no form element',
    JSON.stringify(await filledNames()) === JSON.stringify(['b_one', 'b_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002, rung 3: the smallest block with a submit control ────────────────
  await pointAndFill('[name="g_one"]', 'current-form');
  check('form scope falls back to the block holding a submit control',
    JSON.stringify(await filledNames()) === JSON.stringify(['g_one', 'g_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002 A3: refuses rather than widening ─────────────────────────────────
  await pointAndFill('[name="d_one"]', 'current-form');
  const afterRefusal = await filledNames();
  check('form scope refuses rather than widening to the page',
    afterRefusal.length === 0,
    `filled ${JSON.stringify(afterRefusal)} — an anchored narrowing was overridden (BR-002-2)`);

  // ── UC-003: exactly one control ─────────────────────────────────────────────
  await pointAndFill('[name="b_one"]', 'selected-input');
  check('single-control scope fills one control',
    JSON.stringify(await filledNames()) === JSON.stringify(['b_one']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-001 still works, from the same fixture ───────────────────────────────
  await pointAndFill(undefined, 'all-inputs');
  const wholePage = await filledNames();
  check('page scope still fills everything',
    wholePage.length === 8,
    `filled ${wholePage.length} of 8: ${JSON.stringify(wholePage)}`);

  // ── UC-008 ─────────────────────────────────────────────────────────────────
  //
  // What is provable here and what is not, stated rather than glossed. Once any
  // exclusion exists the background reads the tab's URL, and it may do so only
  // through `activeTab` (BR-008-2) — a grant that follows a *user gesture*. A
  // menu click synthesised over CDP is not one, so `tabs.get()` returns no URL
  // and UC-008 A1 is what runs: the tab is treated as excluded because its
  // address could not be read.
  //
  // That is the safe direction, and asserting it is worth doing — A1 is the
  // branch where a mistake means filling a page that should have been left
  // alone. The *pattern-matching* path is covered by `matchesGlob` in
  // `tests/scope.test.ts` instead, and the gap is recorded against FR-037.
  await inWorker(`chrome.storage.local.set({
    settings: { version: 1, exclusions: { fields: [], domains: ['127.0.0.1/*'] } },
  }).then(() => 'ok')`);

  await pointAndFill('[name="a_one"]', 'current-form');
  const afterExclusion = await filledNames();
  check('a tab whose address cannot be read is not filled (UC-008 A1)',
    afterExclusion.length === 0,
    `filled ${JSON.stringify(afterExclusion)}`);
  check('and the toolbar says so, without being erased by the previous fill',
    (await badgeText()) === 'off',
    `badge showed ${JSON.stringify(await badgeText())}`);
  // UC-008 A1 says the system reports that it could not establish where it was
  // being asked to act. It used to substitute a sentence where the pattern goes,
  // so the tooltip asserted a list entry that does not exist and sent the user
  // looking for it. The badge alone could not catch that — it reads 'off' either
  // way, which is why this assertion is on the words.
  const excludedTitle = await badgeTitle();
  check('and the tooltip says the address could not be read, not that a pattern matched',
    excludedTitle.includes('could not be read') && !excludedTitle.includes('is on your excluded list'),
    `tooltip was ${JSON.stringify(excludedTitle)}`);

  await pointAndFill(undefined, 'all-inputs');
  check('the refusal applies to the page scope too',
    (await filledNames()).length === 0,
    `filled ${JSON.stringify(await filledNames())} — a scope is not a route around exclusion (BR-008-5)`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  server.close();
  chrome?.kill();
  await sleep(200);
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`  (left a temp profile behind: ${profileDir})`);
  }
}

console.log('\n  UC-002, UC-003 and UC-008 — scopes and exclusion\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ scope end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ every scope reaches exactly the controls it names\n');
