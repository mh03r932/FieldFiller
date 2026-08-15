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
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-options-'));
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
    const { result, exceptionDetails } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      page,
    );
    if (exceptionDetails !== undefined) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`page threw: ${String(detail).split('\n')[0]}`);
    }
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

  const storedRules = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings?.rules ?? []))`,
    )));

  // ── Open the options page and add a rule the way a person does ──────────────
  await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
  await sleep(1200);

  check('the options page renders the rule section',
    (await inPage(`document.querySelector('#rules') !== null`)) === true,
    'no #rules container');

  check('an empty list explains itself rather than looking broken',
    (await inPage(`(document.querySelector('#rules p')?.textContent ?? '').length > 20`)) === true,
    `text=${JSON.stringify(await inPage(`document.querySelector('#rules p')?.textContent ?? ''`))}`);

  // Clicked, not called. What is under test is the wiring.
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);

  check('adding a rule opens it for editing',
    (await inPage(`document.querySelector('#rules .rule-body') !== null`)) === true,
    'no editor appeared');

  check('a rule that is not yet valid is not written',
    (await storedRules()).length === 0,
    `stored ${JSON.stringify(await storedRules())} — an incomplete rule reached storage (BR-009-1)`);

  /** Types into a labelled field the way a user would, and fires what a browser fires. */
  const type = async (labelText, value) => {
    await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      if (field === undefined) throw new Error('no field labelled ' + ${JSON.stringify(labelText)});
      const input = field.querySelector('input, textarea');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
  };

  const choose = async (labelText, value) => {
    await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      const select = field.querySelector('select');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  await type('Name', 'Order reference');
  await type('Matches', 'short_code');
  await choose('Generates', 'constant');
  await type('Value', 'FROM-A-RULE');
  await sleep(400);

  const rules = await storedRules();
  check('the completed rule is written without a Save button',
    rules.length === 1 && rules[0]?.generator?.value === 'FROM-A-RULE',
    `stored ${JSON.stringify(rules)}`);
  check('the rule keeps the name it was given, for the report',
    rules[0]?.label === 'Order reference', `label=${JSON.stringify(rules[0]?.label)}`);

  check('the preview shows several samples from the real generator',
    (await inPage(`document.querySelectorAll('#rules .samples li').length`)) > 1,
    `samples=${await inPage(`document.querySelectorAll('#rules .samples li').length`)}`);

  // ── An invalid edit is refused, and the previous version stands ─────────────
  await choose('Generates', 'alphanumeric');
  await type('Template', '{nope}');
  await sleep(300);

  check('an invalid edit shows its problem',
    (await inPage(`document.querySelectorAll('#rules .problem').length`)) > 0,
    'no problem shown');
  check('an invalid edit is not written; the previous rule stands',
    (await storedRules())[0]?.generator?.type === 'alphanumeric' === false ||
      (await storedRules())[0]?.generator?.template !== '{nope}',
    `stored ${JSON.stringify((await storedRules())[0]?.generator)}`);

  await type('Template', 'REF-{digit:3}');
  await sleep(300);
  check('correcting it writes again',
    (await storedRules())[0]?.generator?.template === 'REF-{digit:3}',
    `stored ${JSON.stringify((await storedRules())[0]?.generator)}`);

  // ── Ordering is precedence, and the controls say so ─────────────────────────
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);
  await type('Name', 'Second');
  await type('Matches', 'short_code');
  await choose('Generates', 'constant');
  await type('Value', 'SECOND-RULE');
  await sleep(400);

  check('the new rule is appended, not inserted',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Order reference|Second',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);

  check('the first rule cannot be moved up',
    (await inPage(`document.querySelector('#rules .rule .rule-order button').disabled`)) === true,
    'the up control was available on the first rule');

  await inPage(`document.querySelectorAll('#rules .rule')[1].querySelectorAll('.rule-order button')[0].click()`);
  await sleep(400);
  check('moving a rule up reorders storage',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Second|Order reference',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);
  check('the move is announced for a reader who cannot see the list',
    (await inPage(`document.querySelector('#announcements').textContent`)).includes('Second'),
    `announcement=${JSON.stringify(await inPage(`document.querySelector('#announcements').textContent`))}`);

  // ── The point of all of it: the rule changes what a fill writes ─────────────
  await cdp.send('Page.navigate', { url: pageUrl }, page);
  await sleep(1200);
  const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
    const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
    chrome.action.onClicked.dispatch(tab);
    return 'ok';
  }).catch((error) => 'threw: ' + error.message)`);
  if (fired !== 'ok') throw new Error(`the toolbar trigger did not fire — ${String(fired)}`);

  let landed = '';
  for (let elapsed = 0; elapsed < 6000 && landed === ''; elapsed += 200) {
    await sleep(200);
    landed = String(await inPage(`document.querySelector('[name=short_code]')?.value ?? ''`));
  }

  // "Second" now precedes "Order reference" and both match `short_code`, so
  // first-match-wins decides — which is the whole reason ordering is a feature.
  check('the rule the user wrote is what the page receives',
    landed.startsWith('SECON'),
    `short_code=${JSON.stringify(landed)} — expected the first matching rule's value`);

  // And the page still wins over the rule. `short_code` carries maxlength="5",
  // so `SECOND-RULE` arrives cut to five characters: a rule supplies policy, the
  // field supplies the ceiling, and the ceiling holds (DD-005, FR-072, ND-11).
  // Asserted rather than worked around — the first run of this harness expected
  // the whole string and read the truncation as a failure.
  check('the field’s own constraints still bound what a rule produces',
    landed === 'SECON',
    `short_code=${JSON.stringify(landed)} — expected it cut to the field's maxlength of 5`);
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

console.log('\n  UC-009..UC-013 — a rule authored through the options page\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ options page end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a rule written in the options page reaches the page being filled\n');
