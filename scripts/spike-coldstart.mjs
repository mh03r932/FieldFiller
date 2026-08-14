#!/usr/bin/env node
/**
 * Phase 0's last open row: what does the DD-003 boundary actually cost?
 *
 * Three numbers, measured rather than assumed:
 *
 *   · **channel round trip** (NFR-029, budget 20 ms) — background → agent →
 *     background, using the production `ping`/`pong` exchange. This is the unit
 *     DD-009 multiplies: a cascade makes one round trip per pass per frame, so
 *     the pass cap in NFR-034 has to be chosen against this number and not
 *     against a round one.
 *   · **warm trigger** (NFR-002, budget 100 ms) — trigger to first value, with
 *     the background already running.
 *   · **cold trigger** (NFR-027, budget 400 ms) — the same, after the service
 *     worker has been stopped, so it pays for its own restart.
 *
 * **What this cannot measure yet, and says so rather than implying otherwise.**
 * NFR-028 budgets 250 ms for loading the data corpus. There is no corpus:
 * `src/lib/persona/persona.ts` carries about fifty placeholder entries, so its
 * load time is indistinguishable from zero. The cold number below is therefore a
 * *floor*, and its value now is not pass/fail — it is budget allocation. What
 * NFR-027's 400 ms has left over after the restart is the envelope the real
 * corpus has to fit inside, and knowing that before the corpus is written is the
 * whole reason to run this early.
 *
 * **Nothing here is a test hook.** The trigger is `action.onClicked.dispatch`,
 * as in `e2e-chrome.mjs`; the round trip is the protocol's own `ping`; and the
 * arrival of a value is observed through the `input` event the applier really
 * dispatches. Production code gains nothing for this script's benefit.
 *
 * Usage: node scripts/spike-coldstart.mjs   (after `pnpm run build`)
 *   CHROME_PATH=…  override the browser binary
 *   RUNS=…         samples per measurement (default 7)
 *   HEADFUL=1      show the window
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

const RUNS = Number(process.env['RUNS'] ?? 7);

/** The budgets this spike reports against. Sourced from docs/requirements.md §2. */
const BUDGETS = {
  roundTrip: { ms: 20, id: 'NFR-029', what: 'channel round trip' },
  warm: { ms: 100, id: 'NFR-002', what: 'trigger → first value, warm' },
  restart: { ms: 400, id: 'NFR-027', what: 'service worker restart' },
  cold: { ms: 400, id: 'NFR-027', what: 'cold trigger (restart + warm)' },
};

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

/**
 * Percentiles from a small sample.
 *
 * The median is the headline because a single scheduling hiccup in a seven-run
 * sample moves a mean by more than the thing being measured. The maximum is
 * reported beside it because a budget met on average and missed a third of the
 * time is not met.
 */
function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    n: sorted.length,
  };
}

/** A minimal page: one text input is all a first-value measurement needs. */
const PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><title>spike</title>' +
  '<label>Given name <input name="given_name" autocomplete="given-name"></label>' +
  '<label>Family name <input name="family_name" autocomplete="family-name"></label>' +
  '<label>Email <input name="email" type="email"></label>';

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-spike-'));
let chrome;
let cdp;
let failure;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(PAGE_HTML);
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
  await cdp.send('Page.navigate', { url: pageUrl }, page);
  await sleep(1200);

  /** Finds the extension's service worker target, or undefined if it is stopped. */
  async function workerTarget() {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
  }

  async function waitForWorker() {
    for (let attempt = 0; attempt < 80; attempt++) {
      const found = await workerTarget();
      if (found !== undefined) return found;
      await sleep(100);
    }
    throw new Error('the background service worker never started');
  }

  /**
   * Wakes the worker without filling anything.
   *
   * `runtime.getPlatformInfo` is answered by the browser, not by our code, so it
   * starts the worker for the *next* measurement without contaminating it with a
   * fill of its own.
   */
  async function wakeWorker() {
    const target = await waitForWorker();
    const session = await cdp.attach(target.targetId);
    await cdp.send('Runtime.evaluate', {
      expression: 'chrome.runtime.getPlatformInfo().then(() => "ok")',
      awaitPromise: true, returnByValue: true,
    }, session);
    return session;
  }

  /** Arms the page to stamp the arrival of the first value the applier writes. */
  async function armPage() {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.__ffFirstValue = 0;
        if (!window.__ffArmed) {
          window.__ffArmed = true;
          // Capture phase, and the applier's own \`input\` event — the first
          // observable moment a value exists, without asking the extension for
          // anything it does not already tell the page.
          document.addEventListener('input', () => {
            if (window.__ffFirstValue === 0) window.__ffFirstValue = Date.now();
          }, true);
        }
        for (const field of document.querySelectorAll('input')) field.value = '';
        return 'armed';
      })()`,
      returnByValue: true,
    }, page);
  }

  async function firstValueAt() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'window.__ffFirstValue', returnByValue: true,
      }, page);
      if (Number(result.value) > 0) return Number(result.value);
      await sleep(10);
    }
    return 0;
  }

  /**
   * Dispatches the toolbar listener and returns the wall-clock instant it fired.
   *
   * `Date.now()` on both sides rather than `performance.now()`: the worker and
   * the page have different time origins, and a 1 ms resolution is ample against
   * budgets of 20, 100 and 400 ms.
   */
  async function trigger(session) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `chrome.tabs.query({}).then((tabs) => {
        const tab = tabs.length === 1 ? tabs[0] : tabs.find((candidate) => candidate.active);
        if (tab === undefined) return 0;
        const at = Date.now();
        chrome.action.onClicked.dispatch(tab);
        return at;
      }).catch(() => 0)`,
      awaitPromise: true, returnByValue: true,
    }, session);
    return Number(result.value ?? 0);
  }

  // ── 1 · Channel round trip (NFR-029) ────────────────────────────────────────
  // The protocol's own ping, timed inside the worker so nothing but the message
  // channel is in the measurement. Direction is background → agent → background
  // rather than the descriptors path's agent → background → agent; it is the
  // same channel, the same serialisation and the same process hop, and it is
  // measurable without shipping a hook into production code.
  const warmSession = await wakeWorker();
  const roundTrip = [];
  {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.length === 1 ? tabs[0] : tabs.find((c) => c.active);
        const samples = [];
        // One discarded warm-up: the first message to a frame pays for listener
        // registration that no later message pays again.
        try { await chrome.tabs.sendMessage(tab.id, { kind: 'ping' }); } catch {}
        for (let i = 0; i < ${RUNS * 3}; i++) {
          const started = performance.now();
          const reply = await chrome.tabs.sendMessage(tab.id, { kind: 'ping' });
          if (reply && reply.kind === 'pong') samples.push(performance.now() - started);
        }
        return samples;
      })()`,
      awaitPromise: true, returnByValue: true,
    }, warmSession);
    roundTrip.push(...(result.value ?? []));
  }

  // ── 2 · Warm trigger (NFR-002) ──────────────────────────────────────────────
  const warm = [];
  for (let run = 0; run < RUNS; run++) {
    await armPage();
    const session = await wakeWorker();
    const startedAt = await trigger(session);
    const arrivedAt = await firstValueAt();
    if (startedAt > 0 && arrivedAt > 0) warm.push(arrivedAt - startedAt);
    // Longer than the background's 400 ms settle window. A second trigger
    // arriving while the previous operation is still open is ignored as "already
    // running" (UC-001 A7) — correct behaviour, and it silently costs samples if
    // the gap is shorter than the window.
    await sleep(900);
  }

  // ── 3 · Worker restart, and a composed cold figure (NFR-027) ────────────────
  //
  // The cold trigger cannot be observed end to end, and the reason is worth
  // stating rather than working around. `action.onClicked.dispatch` has to run
  // *inside* the worker, so reaching the worker to dispatch is itself what
  // starts it: any attempt to time "trigger on a stopped worker" has already
  // started the worker before the clock begins. A real toolbar click does not
  // have this problem and cannot be synthesised (see `e2e-chrome.mjs`).
  //
  // So the restart is measured on its own, and the cold figure is *composed* —
  // restart plus warm — and labelled as composed everywhere it appears. That is
  // an upper bound on what a user waits for, since the two overlap in reality:
  // the worker begins handling the click while it is still finishing its own
  // startup. Reporting a composed number honestly beats reporting an observed
  // one that quietly excluded the restart.
  // An extension page, kept open for the whole measurement, as the place to
  // send the waking message from. Measured here: loading an extension page does
  // *not* start the worker — verified, it stayed stopped for 5.6 s — because a
  // service worker starts on the events it has listeners for, and a page load is
  // not one. A message is, which is also the production path: the page agent
  // wakes the background exactly this way when it sends its descriptors.
  const { targetId: wakerTarget } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options.html`,
  });
  const wakerSession = await cdp.attach(wakerTarget);
  await sleep(400);

  const restart = [];
  let restartUnavailable;
  for (let run = 0; run < RUNS; run++) {
    const target = await workerTarget();
    if (target !== undefined) await cdp.send('Target.closeTarget', { targetId: target.targetId });

    // Verified stopped rather than assumed. If Chrome declines to close the
    // target, every "restart" below would be a no-op returning single-digit
    // milliseconds, and the spike would report a flattering number it did not
    // measure.
    let stopped = false;
    for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
      stopped = (await workerTarget()) === undefined;
      if (!stopped) await sleep(50);
    }
    if (!stopped) {
      restartUnavailable = 'the service worker could not be stopped in this Chrome';
      break;
    }

    // Timed inside the extension page rather than by polling from CDP: the
    // promise settles once the worker has started and the message has reached
    // it, which is the whole of the restart cost with none of a poll's
    // granularity in it. A rejection is as good as a resolution here — the
    // background declines to answer a message it does not recognise, but it had
    // to start in order to decline.
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const started = performance.now();
        try { await chrome.runtime.sendMessage({ kind: 'spike-wake' }); } catch {}
        return performance.now() - started;
      })()`,
      awaitPromise: true, returnByValue: true,
    }, wakerSession);

    const elapsed = Number(result.value ?? 0);
    if (!(elapsed > 0)) {
      restartUnavailable = 'the waking message did not return a usable duration';
      break;
    }

    // Confirmed awake, so the next run's "stopped" check is meaningful rather
    // than measuring a worker that never came back.
    if ((await workerTarget()) === undefined) {
      restartUnavailable = 'the service worker did not restart after a message';
      break;
    }

    restart.push(elapsed);
    await sleep(200);
  }

  await cdp.send('Target.closeTarget', { targetId: wakerTarget });

  // ── Report ─────────────────────────────────────────────────────────────────
  const cold =
    restart.length > 0 && warm.length > 0
      ? [summarise(restart).median + summarise(warm).median]
      : [];

  const rows = [
    ['roundTrip', roundTrip],
    ['warm', warm],
    ['restart', restart],
    ['cold', cold],
  ];

  console.log('\n  FieldFiller — DD-003 boundary cost\n');
  for (const [key, samples] of rows) {
    const budget = BUDGETS[key];
    if (samples.length === 0) {
      console.log(`  ?  ${budget.what.padEnd(34)} not measured  (budget ${budget.ms} ms, ${budget.id})`);
      continue;
    }
    const { median, min, max, n } = summarise(samples);
    const verdict = median <= budget.ms ? '✔' : '✖';
    const spread = n > 1 ? `   (${min.toFixed(1)}–${max.toFixed(1)}, n=${n})` : '   (composed)';
    console.log(
      `  ${verdict}  ${budget.what.padEnd(34)} ${median.toFixed(1).padStart(6)} ms` +
        `${spread}   budget ${budget.ms} ms · ${budget.id}`,
    );
  }

  if (restartUnavailable !== undefined) {
    console.log(`\n  ! worker restart not measured: ${restartUnavailable}`);
  }

  if (roundTrip.length > 0) {
    const { median } = summarise(roundTrip);
    console.log('\n  What this means for DD-009:');
    for (const passes of [2, 4, 6]) {
      console.log(
        `    ${passes} passes × ${median.toFixed(1)} ms = ${(passes * median).toFixed(0)} ms of messaging per frame`,
      );
    }
    console.log('    NFR-034 budgets 5 s for the whole cascade; messaging should be a rounding error in it.');
  }

  if (cold.length > 0) {
    const { median } = summarise(cold);
    const left = BUDGETS.cold.ms - median;
    console.log('\n  What this leaves for the corpus (NFR-028 budgets 250 ms):');
    console.log(
      `    ${BUDGETS.cold.ms} ms − ${median.toFixed(0)} ms restart-and-fill = ${left.toFixed(0)} ms of envelope`,
    );
    console.log(
      left >= 250
        ? '    The corpus can be built to NFR-028 as written.'
        : '    NFR-028 cannot be met inside NFR-027 as measured — the corpus budget or the corpus has to shrink.',
    );
  }

  console.log(
    '\n  Caveats, so these numbers are not quoted as more than they are:\n' +
      '    · The corpus does not exist yet (src/lib/persona/persona.ts is a ~50-entry placeholder),\n' +
      '      so every figure here is a floor and NFR-028 remains unmeasured.\n' +
      '    · The cold figure is composed, not observed: dispatching the toolbar listener requires\n' +
      '      reaching into the worker, which starts it. Restart and fill overlap in reality, so the\n' +
      '      sum is an upper bound.\n' +
      '    · The round trip is measured background → agent → background. The descriptors path runs\n' +
      '      the other way over the same channel; NFR-029 also claims independence from batch size,\n' +
      '      which this does not test.\n' +
      '    · Headless, on an idle machine. A loaded machine and a real profile are both slower.',
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try { cdp?.close(); } catch { /* already gone with the browser */ }
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

if (failure !== undefined) {
  console.error(`\n✖ spike failed: ${failure}`);
  process.exit(1);
}

// Deliberately exits 0 whatever the numbers say. This is a measurement, not a
// gate: it informs NFR-034's pass cap and the corpus budget, and a spike that
// fails the build the first time a machine is busy teaches people to skip it.
console.log('');
