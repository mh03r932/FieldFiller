#!/usr/bin/env node
/**
 * The walking skeleton, end to end in a real Chrome: serve the reference page,
 * invoke a fill the way the toolbar does, and check what actually landed in the
 * DOM (NFR-014, Phase 1).
 *
 * Distinct from `smoke-chrome.mjs`, which asks whether the extension *loaded*.
 * This asks whether it *works* — the whole pipeline, background → agent →
 * descriptors → values → DOM → events, which is the integration risk the
 * walking skeleton exists to retire early.
 *
 * The trigger is `action.onClicked` dispatched from the background's own
 * context. A real toolbar click cannot be synthesised — it happens in browser
 * chrome, outside any page — but the listener it invokes is the same one, so
 * everything downstream of the trigger is exercised for real.
 *
 * Usage: node scripts/e2e-chrome.mjs   (after `pnpm run build`)
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const REFERENCE_PAGE = join(ROOT, 'tests', 'fixtures', 'reference.html');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error('No Chrome or Chromium found. Set CHROME_PATH.');
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
  };
}

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-e2e-'));
const failures = [];
let chrome;
let cdp;

const html = readFileSync(REFERENCE_PAGE, 'utf8');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  const debugPort = await freePort();
  chrome = spawn(findChrome(), [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    ...(process.env['HEADFUL'] === '1' ? [] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let attempt = 0; attempt < 100 && wsUrl === undefined; attempt++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl;
    } catch { await sleep(150); }
  }
  cdp = await connect(wsUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
  const page = await cdp.attach(targetId);
  await cdp.send('Runtime.enable', {}, page);
  await sleep(1500);

  // The service worker is started by an event, so it may not exist yet.
  let worker;
  for (let attempt = 0; attempt < 60 && worker === undefined; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    if (worker === undefined) await sleep(100);
  }
  if (worker === undefined) throw new Error('the background service worker never started');
  const workerSession = await cdp.attach(worker.targetId);

  // Invoke the toolbar listener against the page's tab.
  // The tab is identified by being active, not by its URL: without the `tabs`
  // permission Chrome withholds `url` and `title` from every tab it returns, and
  // NFR-008 forbids that permission. Production never needs this — the click
  // hands the listener its tab — so the awkwardness is the harness's alone.
  const triggered = await cdp.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const tab = tabs[0] ?? undefined;
      if (tab === undefined) return 'no active tab';
      if (typeof chrome.action.onClicked.dispatch !== 'function') {
        return 'chrome.action.onClicked.dispatch is not available in this Chrome';
      }
      chrome.action.onClicked.dispatch(tab);
      return 'ok:' + tab.id;
    }).catch((error) => 'threw: ' + error.message)`,
    awaitPromise: true, returnByValue: true,
  }, workerSession);

  const outcome = String(triggered.result.value ?? '');
  if (!outcome.startsWith('ok:')) {
    // Reported rather than swallowed. A trigger that never fired looks exactly
    // like an engine that filled nothing, and the two need entirely different
    // fixes.
    throw new Error(`the toolbar trigger did not fire — ${outcome}`);
  }

  // The fill is a message round trip; give it room without making the test slow
  // when it succeeds.
  let filled = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(150);
    const result = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify(Object.fromEntries(
        [...document.querySelectorAll('input, textarea')].map((el) => [el.name, el.value])
      ))`,
      returnByValue: true,
    }, page);
    filled = JSON.parse(result.result.value);
    if (filled.given_name) break;
  }

  const check = (label, condition, detail) => {
    if (condition) console.log(`✔ ${label}`);
    else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
  };

  check('text inputs received values', Boolean(filled.given_name && filled.family_name),
    `given_name=${JSON.stringify(filled.given_name)}`);

  // ND-1, the headline quality claim: the fields agree because they come from
  // one record, not because generators were told to look at each other.
  //
  // Compared after stripping diacritics, because the persona strips them when
  // deriving the address — a name like "Engström" must not produce an email
  // containing "ö". Asserting on the raw name would fail on a correct fill.
  const asciiFold = (value) =>
    String(value).toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  const email = asciiFold(filled.email ?? '');
  const given = asciiFold(filled.given_name ?? '');
  const family = asciiFold(filled.family_name ?? '');
  check('the persona is coherent across fields',
    given !== '' && family !== '' && email.includes(given) && email.includes(family),
    `email=${filled.email} name=${filled.given_name} ${filled.family_name}`);

  check('autocomplete purposes were honoured', filled.postcode !== '' && filled.town !== '',
    `town=${filled.town} postcode=${filled.postcode}`);

  // BR-004-7 / D4: the control's own constraints are a ceiling.
  check('maxlength was honoured', (filled.short_code ?? '').length <= 5,
    `short_code=${JSON.stringify(filled.short_code)}`);
  check('minlength was honoured', (filled.long_value ?? '').length >= 12,
    `long_value=${JSON.stringify(filled.long_value)}`);

  // ND-10: a textarea deserves a paragraph, not a global 20-character default.
  check('the textarea got more than a short phrase', (filled.notes ?? '').length > 20,
    `notes=${JSON.stringify(filled.notes)}`);

  // ND-11: eight lowercase letters would fail the forms this feature exists for.
  const password = filled.password ?? '';
  check('the password would pass a registration form',
    /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^\w]/.test(password),
    `password length ${password.length}`);

  // UC-005: these must be untouched, and "untouched" is the value they shipped with.
  check('disabled fields were left alone', filled.disabled_field === '');
  check('read-only fields were left alone', filled.readonly_field === 'untouched',
    `readonly_field=${JSON.stringify(filled.readonly_field)}`);
  check('aria-disabled fields were left alone', filled.aria_disabled_field === '');
  check('hidden inputs were left alone', filled.csrf_token === 'untouched');

  // Phase 2 kinds must not have been filled by accident.
  check('number inputs are not yet filled', (filled.quantity ?? '') === '');

  // Printed because coherence is far more convincing read than asserted: the
  // point of ND-1 is that these lines describe one person.
  console.log('\n  what landed on the page:');
  for (const field of ['given_name', 'family_name', 'email', 'phone', 'street', 'town', 'postcode']) {
    console.log(`    ${field.padEnd(12)} ${filled[field] ?? ''}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  if (chrome !== undefined) {
    chrome.kill();
    const exited = await Promise.race([
      new Promise((resolve) => chrome.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited) chrome.kill('SIGKILL');
  }
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { console.warn(`  (left a temp profile behind: ${profileDir})`); }
}

if (failures.length > 0) {
  console.error('\n✖ end-to-end fill failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log('\n✔ a toolbar click fills the reference page in Chromium');
