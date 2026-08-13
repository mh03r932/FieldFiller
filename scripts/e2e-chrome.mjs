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
 * chrome, outside any page, where neither CDP's `Input` domain nor any page
 * script can reach — but the listener it invokes is the same one, so everything
 * downstream of the trigger is exercised for real.
 *
 * `dispatch()` is an undocumented member of Chrome's event objects. Verified
 * present in Chrome for Testing 151: `Object.keys(chrome.action.onClicked)`
 * yields `addListener, removeListener, hasListener, hasListeners, dispatch`.
 * Being undocumented, it may be removed — which is what the explicit check below
 * is for. It reports the absence as its own diagnosis rather than letting the
 * run look like an engine that filled nothing.
 *
 * There is no better option available. The keyboard commands are handled by the
 * browser rather than the page, so a synthesised key event never reaches them,
 * and a message-based back door would mean shipping a test hook in production
 * code to every user.
 *
 * Usage: node scripts/e2e-chrome.mjs   (after `pnpm run build`)
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
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
const REFERENCE_PAGE = join(ROOT, 'tests', 'fixtures', 'reference.html');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Playwright's pinned Chromium, if it has been downloaded.
 *
 * Used as a browser *locator* only — the driving below is still plain CDP. It is
 * preferred over whatever Chrome the machine happens to have so that a local run
 * and a CI run exercise the same build: "works on my machine" is otherwise a
 * statement about an unpinned browser.
 */
function playwrightChromium() {
  try {
    const require = createRequire(import.meta.url);
    const path = require('playwright').chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    // Not installed. The candidate list below still applies.
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
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-e2e-'));
const failures = [];
let chrome;
let cdp;

const html = readFileSync(REFERENCE_PAGE, 'utf8');

// A second origin, so the cross-origin frame is genuinely cross-origin (C-007).
// `localhost` and `127.0.0.1` are different origins even on the same port, and
// different ports would be enough on their own — using both makes the intent
// unmistakable to anyone reading the assertion later.
const crossOriginServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>cross-origin</title>' +
      '<label>Cross name <input name="xorigin_name" autocomplete="given-name"></label>' +
      '<label>Cross email <input name="xorigin_email" type="email"></label>',
  );
});
await new Promise((resolve) => crossOriginServer.listen(0, '127.0.0.1', resolve));
const crossOriginUrl = `http://localhost:${crossOriginServer.address().port}/`;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    html.replace(
      '<iframe id="cross-origin" title="cross-origin frame"',
      `<iframe id="cross-origin" title="cross-origin frame" src="${crossOriginUrl}"`,
    ),
  );
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
    // CI containers run as root, where Chrome's sandbox refuses to start, and
    // their /dev/shm is typically too small for the renderer. Applied only when
    // CI is set, so a developer's machine keeps the sandbox it should have.
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

  // Navigate the tab Chrome already opened rather than creating a second one, so
  // the browser has exactly one tab. The trigger below then identifies it by
  // being the only one, instead of by being focused — focus is not a property a
  // headless browser under `--no-sandbox` reliably has, and when it went missing
  // the fill was dispatched to a tab that was not the reference page and every
  // assertion failed at once, as though the engine had stopped working.
  const initial = (await cdp.send('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'page',
  );
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Page.navigate', { url: pageUrl }, page);
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
    expression: `chrome.tabs.query({}).then((tabs) => {
      // The only tab, not the focused one. Without the \`tabs\` permission Chrome
      // withholds \`url\` from every tab it returns, so identity has to come from
      // there being exactly one — which is why the harness navigates the initial
      // tab rather than opening a second.
      const tab = tabs.length === 1 ? tabs[0] : tabs.find((candidate) => candidate.active);
      if (tab === undefined) return 'no tab to fill among ' + tabs.length;
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
  // Collected from every frame, not only the top one. Each frame is its own CDP
  // target with its own isolated worlds, so the values are read per target and
  // merged — which is also the only way to see into a cross-origin frame.
  const collectExpression = `JSON.stringify(Object.fromEntries(
    (function walk(root, out) {
      for (const el of root.querySelectorAll('input, textarea, select')) {
        if (el.type === 'checkbox' || el.type === 'radio') out.push([el.name + ':' + el.value, el.checked]);
        else if (el.multiple) out.push([el.name, [...el.selectedOptions].map((o) => o.value).join(',')]);
        else out.push([el.name, el.value]);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
      // Same-origin and srcdoc frames are part of this target rather than
      // separate ones, so their contents are only reachable through
      // contentDocument. A cross-origin frame throws here and is read from its
      // own target instead.
      for (const frame of root.querySelectorAll('iframe')) {
        try { if (frame.contentDocument) walk(frame.contentDocument, out); } catch {}
      }
      return out;
    })(document, [])
  ))`;

  // Sessions are reused across polls rather than reattached each time. The poll
  // runs up to forty times, and attaching per iteration leaks a session per
  // frame per attempt — harmless here only because the browser is killed
  // afterwards, which is not a property worth relying on.
  const sessions = new Map();

  async function collect() {
    const merged = {};
    const { targetInfos } = await cdp.send('Target.getTargets');
    const frames = targetInfos.filter(
      (target) => target.type === 'iframe' && target.url.startsWith('http://'),
    );

    for (const target of [{ targetId }, ...frames]) {
      try {
        let session = sessions.get(target.targetId);
        if (session === undefined) {
          session = await cdp.attach(target.targetId);
          sessions.set(target.targetId, session);
        }
        const result = await cdp.send(
          'Runtime.evaluate',
          { expression: collectExpression, returnByValue: true },
          session,
        );
        Object.assign(merged, JSON.parse(result.result.value));
      } catch {
        // A frame that went away between listing and reading is not a failure of
        // the fill; the assertions below decide what was required. Its session is
        // dropped so a replacement frame with the same id attaches cleanly.
        sessions.delete(target.targetId);
      }
    }
    return merged;
  }

  let filled = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(200);
    filled = await collect();
    if (filled.given_name && filled.xorigin_name) break;
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

  // Every control kind (Phase 2).
  check('number inputs are filled within their constraints',
    Number(filled.quantity) >= 1 && Number(filled.quantity) <= 10,
    `quantity=${filled.quantity}`);
  check('date inputs get a date the browser accepts', /^\d{4}-\d{2}-\d{2}$/.test(filled.start_date ?? ''),
    `start_date=${filled.start_date}`);
  check('selects choose a real option', ['gb', 'nl'].includes(filled.country ?? ''),
    `country=${filled.country}`);
  // D3: "Ireland" is disabled and must never be selected.
  check('disabled options are never selected', filled.country !== 'ie', `country=${filled.country}`);
  check('consent checkboxes are ticked', filled['terms:on'] === true,
    `terms=${filled['terms:on']}`);
  check('exactly one radio in the group is chosen',
    [filled['contact:email'], filled['contact:post']].filter(Boolean).length === 1,
    `email=${filled['contact:email']} post=${filled['contact:post']}`);

  // UC-006 / D2 / ND-7: confirmations agree with their source, including one
  // identified only by its label, and regardless of what sits between them.
  check('confirm email matches the email', (filled.email ?? '') === (filled.confirm_email ?? ''),
    `${filled.email} vs ${filled.confirm_email}`);
  check('confirm password matches the password',
    (filled.pw ?? '') !== '' && filled.pw === filled.pw_second,
    `${filled.pw} vs ${filled.pw_second}`);

  // FR-071 / ND-16: the honeypot is positioned off-screen and must be left alone.
  check('the honeypot was not filled', (filled.company_url_hp ?? '') === '',
    `company_url_hp=${JSON.stringify(filled.company_url_hp)}`);

  // BR-005-3: the second form's radio shares the group name and must be untouched
  // by a fill scoped to the page — it is a different group.
  check('the unrelated form was filled too, being on the same page',
    (filled.unrelated_note ?? '') !== '');

  // FR-008: `querySelectorAll` does not descend into a shadow root, which is why
  // every Lit/Stencil/Ionic design system is invisible to the reference.
  check('open shadow roots are filled', (filled.shadow_name ?? '') !== '',
    `shadow_name=${JSON.stringify(filled.shadow_name)}`);
  // C-006: a closed root is unreachable by anyone, and we do not pretend
  // otherwise. Its field must be absent from the results entirely.
  check('closed shadow roots are left alone', filled.closed_shadow_name === undefined);

  // FR-007 / C-007: both frames filled, including the cross-origin one, which
  // can only be reached by injecting into that frame.
  check('same-origin frames are filled', (filled.frame_name ?? '') !== '',
    `frame_name=${JSON.stringify(filled.frame_name)}`);
  check('cross-origin frames are filled', (filled.xorigin_name ?? '') !== '',
    `xorigin_name=${JSON.stringify(filled.xorigin_name)}`);

  // BR-001-1, the reason frames share one operation: a checkout whose card
  // fields sit in a payment iframe must receive the same person as the billing
  // fields in the parent document.
  // The emptiness check is not redundant: when the fill did not run at all, every
  // surface holds "" and "they all agree" passed while nothing had been filled.
  // An equality assertion over possibly-absent values has to require presence
  // too, or it is loudest exactly when it is least true.
  check('every frame received the same persona',
    (filled.given_name ?? '') !== '' &&
    filled.given_name === filled.frame_name && filled.given_name === filled.xorigin_name &&
    filled.given_name === filled.shadow_name,
    `top=${filled.given_name} frame=${filled.frame_name} cross=${filled.xorigin_name} shadow=${filled.shadow_name}`);

  // Printed because coherence is far more convincing read than asserted: the
  // point of ND-1 is that these lines describe one person.
  console.log('\n  what landed on the page:');
  for (const field of ['given_name', 'family_name', 'email', 'phone', 'street', 'town', 'postcode']) {
    console.log(`    ${field.padEnd(12)} ${filled[field] ?? ''}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  // Closed explicitly, matching both smoke harnesses. Relying on process exit to
  // tidy up works right until something wants to run two of these in one
  // process.
  try { cdp?.close(); } catch { /* already gone with the browser */ }
  server.close();
  crossOriginServer.close();
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
