#!/usr/bin/env node
/**
 * What the page agent costs a page it never fills: NFR-005's load impact and
 * NFR-004's idle footprint.
 *
 * Both are stated as budgets over *presence* rather than over work — the agent
 * is declared against all URLs and all frames (DD-001), so it loads on every
 * page the user visits and most of them are never filled. That is the cost this
 * measures, and it is the one the persistent-injection decision has to keep
 * paying for.
 *
 * **Measured as a difference between two browsers, not as an absolute.** A page
 * load takes as long as it takes; what the requirement bounds is what the
 * extension *adds*. So the same page is loaded the same number of times in a
 * Chromium with the extension and a Chromium without it, and the answer is the
 * gap between the medians. An absolute number would be a statement about this
 * machine.
 *
 * **It also settles the one assumption in the performance chain that has never
 * been measured.** NFR-003's 40 KB page-agent budget is not an independent
 * choice — its own text derives it from this budget, at "~0.1 ms/KB for parse
 * and compile", so the size gate that runs in CI on every build rests on a
 * figure nobody has checked. The compile probe below checks it. If the real
 * cost per kilobyte is much higher, the 40 KB budget is too loose for the 15 ms
 * it claims to serve; if much lower, the budget is tighter than it needs to be
 * and the argument for it is not the one written down.
 *
 * Usage: pnpm run build && node scripts/spike-page-cost.mjs
 *   CHROME_PATH=…  override the browser binary
 *   LOADS=…        measured page loads per browser (default 20, NFR-005's number)
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeChromium, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const AGENT = join(EXTENSION_DIR, 'content-scripts', 'page-agent.js');
const LOADS = Number(process.env['LOADS'] ?? 20);

/** The bounds NFR-005 and NFR-004 state. */
const LOAD_BUDGET_MS = 15;
const HEAP_BUDGET_BYTES = 2 * 1024 * 1024;

/** Loads discarded before measuring: a fresh browser's first navigations are not representative. */
const WARMUP = 3;

/** Heap samples per browser. The number moves between reads, so one of them is not a measurement. */
const HEAP_SAMPLES = 5;

if (!existsSync(join(EXTENSION_DIR, 'manifest.json')) || !existsSync(AGENT)) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const agentSource = readFileSync(AGENT, 'utf8');
const agentBytes = Buffer.byteLength(agentSource);

/**
 * The reference page, at the size §10's parity criterion names.
 *
 * Sixty fields rather than five hundred, because this is not a measurement about
 * page size: the agent registers a listener at `document_idle` and walks nothing
 * until a fill is asked for, so what it costs a page is dominated by fetching,
 * parsing and compiling its own bundle. A page big enough to be realistic and
 * small enough that its own layout does not swamp the difference.
 */
function reference() {
  const fields = [];
  for (let n = 0; n < 60; n++) {
    fields.push(
      `<p><label for="f${n}">Field ${n}</label> <input id="f${n}" name="field_${n}" type="text"></p>`,
    );
  }
  return `<!doctype html><meta charset="utf-8"><title>reference</title><form>${fields.join('')}</form>`;
}

const page = reference();
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)];
};

/**
 * One browser, measured end to end.
 *
 * `extensionDir` of `undefined` launches a Chromium with no extension at all,
 * which is the control. Everything else about the two runs is identical, down to
 * the profile being fresh and the page being served with `no-store` so neither
 * browser gets to answer a navigation from cache the other paid for.
 */
async function sample(extensionDir) {
  const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-pagecost-'));
  let chrome;
  let cdp;
  try {
    ({ chrome, cdp } = await launchChromium(extensionDir, profileDir));

    const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
    const targetId =
      initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const session = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('HeapProfiler.enable', {}, session);

    const inPage = async (expression) => {
      const { result } = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        session,
      );
      return result.value;
    };

    const loads = [];
    for (let n = 0; n < LOADS + WARMUP; n++) {
      await cdp.send('Page.navigate', { url: pageUrl }, session);
      // `document_idle` is after `load`, so a read taken the moment `load` fires
      // would miss the agent entirely and report the control's number twice.
      await sleep(250);
      const timing = Number(await inPage(`(() => {
        const entry = performance.getEntriesByType('navigation')[0];
        return entry === undefined ? -1 : entry.loadEventEnd;
      })()`));
      if (n >= WARMUP && timing >= 0) loads.push(timing);
    }

    const heaps = [];
    for (let n = 0; n < HEAP_SAMPLES; n++) {
      // Collected before every read. Without it the number includes whatever
      // has not been swept yet, which drifts between reads and would be
      // attributed to whichever browser happened to be sampled later.
      await cdp.send('HeapProfiler.collectGarbage', {}, session);
      await sleep(200);
      heaps.push(Number((await cdp.send('Runtime.getHeapUsage', {}, session)).usedSize));
    }

    // The cross-check of NFR-003's derivation, run in the same page for the same
    // reason the loads are: a compile time is a property of this machine's V8,
    // and only the per-kilobyte figure travels.
    const compile = Number(await inPage(`(() => {
      const source = ${JSON.stringify(agentSource)};

      /**
       * Every iteration compiles a *distinct* source, and that is the whole
       * measurement rather than a detail of it.
       *
       * V8 keeps a compilation cache keyed on the source string, so compiling
       * the same text twice is a lookup rather than a compile — the first
       * version of this probe reported 0.00 ms and would have "disproved" the
       * derivation by measuring a cache hit. A unique suffix per copy defeats
       * it. The sources are built before the clock starts so the concatenation
       * is not timed with them.
       */
      const sources = [];
      for (let n = 0; n < 15; n++) sources.push(source + '\\n//' + n);

      const runs = [];
      for (const text of sources) {
        const at = performance.now();
        new Function(text);
        runs.push(performance.now() - at);
      }
      runs.sort((a, b) => a - b);
      return runs[Math.floor(runs.length / 2)];
    })()`));

    return { loads, heap: median(heaps), compile };
  } finally {
    await closeChromium({ chrome, cdp, profileDir });
  }
}

try {
  console.log(`\n  NFR-005 and NFR-004 — what the page agent costs a page it never fills\n`);
  console.log(`  Reference page: 60 fields, served no-store. ${LOADS} measured loads per browser` +
    ` (${WARMUP} discarded first).`);
  console.log(`  Page agent: ${agentBytes} bytes minified and uncompressed.\n`);

  const withAgent = await sample(EXTENSION_DIR);
  const without = await sample(undefined);

  const loadWith = median(withAgent.loads);
  const loadWithout = median(without.loads);
  const added = loadWith - loadWithout;

  console.log('  NFR-005 — page load impact\n');
  console.log(`  · with the extension       median ${loadWith.toFixed(1)} ms   ` +
    `(range ${Math.min(...withAgent.loads).toFixed(1)}–${Math.max(...withAgent.loads).toFixed(1)})`);
  console.log(`  · with no extension        median ${loadWithout.toFixed(1)} ms   ` +
    `(range ${Math.min(...without.loads).toFixed(1)}–${Math.max(...without.loads).toFixed(1)})`);
  console.log(`  · added by the extension          ${added >= 0 ? '+' : ''}${added.toFixed(1)} ms   ` +
    `against a ${LOAD_BUDGET_MS} ms budget`);
  console.log(`    ${added <= LOAD_BUDGET_MS ? '✔ inside' : '✖ over'} the budget\n`);

  const heapAdded = withAgent.heap - without.heap;
  console.log('  NFR-004 — idle footprint\n');
  console.log(`  · with the extension       ${(withAgent.heap / 1024).toFixed(0)} KB of JS heap`);
  console.log(`  · with no extension        ${(without.heap / 1024).toFixed(0)} KB of JS heap`);
  console.log(`  · added by the extension   ${heapAdded >= 0 ? '+' : ''}${(heapAdded / 1024).toFixed(0)} KB   ` +
    `against a ${HEAP_BUDGET_BYTES / 1024 / 1024} MB budget`);
  console.log(`    ${heapAdded <= HEAP_BUDGET_BYTES ? '✔ inside' : '✖ over'} the budget`);
  console.log('    (a content script shares the renderer\'s isolate, so its heap is counted here;');
  console.log('     the difference is the agent\'s share and the absolute is this machine\'s.)\n');

  console.log('  NFR-003\'s derivation — "~0.1 ms/KB for parse and compile"\n');
  const perKb = withAgent.compile / (agentBytes / 1024);
  console.log(`  · compiling the agent      ${withAgent.compile.toFixed(2)} ms for ${(agentBytes / 1024).toFixed(1)} KB` +
    `  =  ${perKb.toFixed(3)} ms/KB`);
  console.log(`  · the derivation assumes   0.100 ms/KB, so 40 KB ≈ 4 ms a frame`);
  console.log(`  · measured, 40 KB would be ${(40 * perKb).toFixed(1)} ms a frame\n`);
  console.log('    A lazy compile, so this is the parse the browser actually does at load rather');
  console.log('    than a full compile of every function body — the same laziness a real script');
  console.log('    load gets. It bounds the derivation rather than replacing it.\n');
} catch (error) {
  console.error(`\n✖ page-cost spike failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  server.close();
}
