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
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'reference.html');

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
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-locale-'));
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

/**
 * What each locale must produce, expressed as shape rather than as content.
 *
 * The corpus decides *which* town; this decides what a town's postcode has to
 * look like in that country. Asserting the exact values would mean copying the
 * corpus into the harness, and a check that restates its subject proves nothing.
 *
 * The reference page's `country` field is a `<select>`, so it is answered from
 * the options the page offers rather than from the persona (UC-004 A3). It is
 * not checked here for that reason — the persona's own country is covered by
 * the unit tests, where it is not competing with a fixed option list.
 */
const EXPECTED = {
  'en-US': {
    phone: /^\+1 \d{3}-555-01\d{2}$/,
    postcode: /^\d{5}$/,
  },
  'de-CH': {
    phone: /^\+41 7[5-9] \d{3} \d{2} \d{2}$/,
    postcode: /^\d{4}$/,
  },
};

const filledPerLocale = {};

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

  /**
   * Fills the reference page with one locale selected, and reads back what
   * landed on it.
   *
   * The locale goes through `chrome.storage` rather than being injected, so the
   * whole path is exercised: stored value, tolerant parse, `auto` resolution
   * bypassed by an explicit choice, corpus selection, record, fill.
   */
  async function fillWith(locale) {
    await inWorker(`chrome.storage.local.set({ settings: { version: 1, locale: '${locale}' } }).then(() => 'ok')`);
    await cdp.send('Page.navigate', { url: pageUrl }, page);
    await sleep(1200);

    const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
      if (tab === undefined) return 'no tab';
      chrome.action.onClicked.dispatch(tab);
      return 'ok';
    }).catch((error) => 'threw: ' + error.message)`);
    if (fired !== 'ok') throw new Error(`the toolbar trigger did not fire — ${String(fired)}`);

    let filled;
    for (let elapsed = 0; elapsed < 6000 && filled === undefined; elapsed += 200) {
      await sleep(200);
      const read = await inPage(`(() => {
        const value = (name) => document.querySelector('[name=' + name + ']')?.value ?? '';
        return JSON.stringify({
          given: value('given_name'), phone: value('phone'), postcode: value('postcode'),
          town: value('town'), street: value('street'),
        });
      })()`);
      const candidate = JSON.parse(String(read));
      if (candidate.given !== '' && candidate.phone !== '' && candidate.postcode !== '') filled = candidate;
    }
    if (filled === undefined) throw new Error(`the ${locale} fill never produced values`);

    // Wait for the *operation* to close, not just for values to land. A second
    // invocation while one is running is ignored on purpose (UC-001 A7), so a
    // harness that fills twice has to let the first finish or it scores the
    // engine's correct refusal as a missing fill. The badge is set when the
    // operation completes, which makes it the signal — and this cost an hour to
    // learn, which is why it is written down here.
    for (let elapsed = 0; elapsed < 8000; elapsed += 200) {
      const badge = await inWorker(`chrome.tabs.query({}).then((t) =>
        chrome.action.getBadgeText({ tabId: (t.find((x) => x.active) ?? t[0]).id }))`);
      if (String(badge ?? '') !== '') break;
      await sleep(200);
    }
    return filled;
  }

  for (const locale of ['en-US', 'de-CH']) {
    const filled = await fillWith(locale);
    filledPerLocale[locale] = filled;
    const expected = EXPECTED[locale];

    check(`${locale}: the phone number is written the way that country writes one`,
      expected.phone.test(filled.phone), `phone=${JSON.stringify(filled.phone)}`);
    check(`${locale}: the postal code has that country's shape`,
      expected.postcode.test(filled.postcode), `postcode=${JSON.stringify(filled.postcode)}`);
    check(`${locale}: the address and the person both arrived`,
      filled.given !== '' && filled.street !== '' && filled.town !== '',
      JSON.stringify(filled));
  }

  // The check that makes the other eight mean something: a setting nobody reads
  // would let both runs produce identical output and every shape assertion above
  // would still pass for one of the two.
  check('the setting is what selects the corpus, not the seed',
    filledPerLocale['en-US'].town !== filledPerLocale['de-CH'].town &&
      filledPerLocale['en-US'].phone !== filledPerLocale['de-CH'].phone,
    `en-US=${filledPerLocale['en-US'].town} de-CH=${filledPerLocale['de-CH'].town}`);
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

console.log('\n  The corpus, per locale, through storage\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}
for (const [locale, filled] of Object.entries(filledPerLocale)) {
  console.log(`\n  ${locale}: ${filled.given}, ${filled.street}, ${filled.postcode} ${filled.town}`);
  console.log(`  ${' '.repeat(locale.length)}  ${filled.phone}`);
}

if (failures.length > 0) {
  console.error('\n✖ locale end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ each locale produces a record that belongs to its country\n');
