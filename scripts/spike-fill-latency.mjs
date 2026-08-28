#!/usr/bin/env node
/**
 * The measurement NFR-001 names: 500 fillable controls, filled within 500 ms
 * from the trigger, on the first pass.
 *
 * Recorded rather than asserted, and in a spike rather than a harness, for the
 * reason `spike-rule-scale.mjs` gives about NFR-024: a number this close to the
 * machine belongs where it can be read and argued with, and a CI runner under
 * load is not evidence about it either way. `e2e-chrome.mjs` decides whether the
 * fill is *correct*; this decides whether it is fast enough at the size the
 * requirement names.
 *
 * **What "the first pass" means here, and how it is separated from the rest.**
 * DD-009 scoped this budget to the first pass because that is what a user
 * perceives as the form filling — a cascade the page then runs is bounded
 * separately by NFR-034. Rather than try to observe pass boundaries from
 * outside, this records the time of each control's **first** write and takes the
 * last of them. Every control is written once in the first pass, so that
 * maximum *is* the moment the first pass finished writing, and it stays correct
 * however many further passes the settle loop runs or however many events one
 * write dispatches. The fixture is deliberately static — nothing on the page
 * reacts to being filled — so there is no cascade to confuse it with.
 *
 * **Cold and warm are reported separately, because the requirement does not say
 * which it means.** An MV3 background is started by the event it handles, so the
 * first fill after a browser start pays a worker start-up that no later fill
 * pays; NFR-027..029 bound that separately and `spike-coldstart.mjs` measures
 * it. Folding the two together would produce one number that describes neither.
 *
 * Usage: pnpm run build && node scripts/spike-fill-latency.mjs
 *   CHROME_PATH=…  override the browser binary
 *   CONTROLS=…     controls on the page (default 500, the number NFR-001 names)
 *   RUNS=…         fills measured (default 9)
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachToWorker,
  closeChromium,
  derivedExtensionId,
  launchChromium,
  sleep,
  waitForAgent,
} from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const CONTROLS = Number(process.env['CONTROLS'] ?? 500);
const RUNS = Number(process.env['RUNS'] ?? 9);

/** The bound NFR-001 states, in milliseconds. */
const BUDGET = 500;

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

/**
 * A page of ordinary controls, cycled through the kinds a real form mixes.
 *
 * Every control is laid out and visible: `skipHidden` ships on, so a hidden
 * control is skipped and would quietly shrink the thing being measured. Each
 * carries a name the identity sources can read, because a control that matches
 * nothing still costs the walk and the write but skips the interesting half of
 * the generator work — a fixture of anonymous inputs would report a number no
 * real page reproduces.
 *
 * Deliberately inert. Nothing here reacts to being filled, so the settle loop
 * finds nothing to do on its second pass and the measurement below is not
 * competing with a cascade (NFR-034's territory, not this one's).
 */
const NAMES = [
  'first_name', 'last_name', 'email', 'telephone', 'company', 'street_address',
  'postcode', 'city', 'order_reference', 'notes',
];

function fixture(count) {
  const fields = [];
  for (let n = 0; n < count; n++) {
    const name = `${NAMES[n % NAMES.length]}_${n}`;
    const label = `<label for="c${n}">Field ${n}</label>`;
    let control;
    switch (n % 10) {
      case 3:
        control = `<input id="c${n}" data-n="${n}" type="email" name="${name}">`;
        break;
      case 4:
        control = `<input id="c${n}" data-n="${n}" type="number" name="${name}" min="1" max="999">`;
        break;
      case 5:
        control = `<input id="c${n}" data-n="${n}" type="date" name="${name}">`;
        break;
      case 6:
        control = `<input id="c${n}" data-n="${n}" type="checkbox" name="${name}">`;
        break;
      case 7:
        control = `<select id="c${n}" data-n="${n}" name="${name}"><option value=""></option><option value="a">A</option><option value="b">B</option></select>`;
        break;
      case 8:
        control = `<textarea id="c${n}" data-n="${n}" name="${name}"></textarea>`;
        break;
      case 9:
        control = `<input id="c${n}" data-n="${n}" type="tel" name="${name}">`;
        break;
      default:
        control = `<input id="c${n}" data-n="${n}" type="text" name="${name}">`;
    }
    fields.push(`<p>${label} ${control}</p>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>latency</title><form>${fields.join('')}</form>`;
}

const page = fixture(CONTROLS);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-latency-'));
const TAB = `tabs.find((t) => t.active && t.windowId !== undefined)`;

let chrome;
let cdp;

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const pageSession = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, pageSession);
  await cdp.send('Runtime.enable', {}, pageSession);
  const workerSession = await attachToWorker(cdp, extensionId);

  const inPage = async (expression) => {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      pageSession,
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
   * One measured fill, from a freshly loaded page.
   *
   * Both clocks are `Date.now()`. The trigger is timed in the worker and the
   * writes in the page, which are different contexts and therefore different
   * `performance.now()` origins — wall clock is the only one they share. Its
   * millisecond resolution is coarse, and against a 500 ms budget that is the
   * right trade: a 1 ms uncertainty on a number in the hundreds is noise, where
   * a shared-origin high-resolution clock is not available at all.
   */
  const measure = async () => {
    await cdp.send('Page.navigate', { url: pageUrl }, pageSession);
    await sleep(300);
    await waitForAgent(cdp, workerSession, TAB);

    // Installed after the agent is listening and before the trigger, so nothing
    // it records predates the fill. Capture phase, on the document, so one pair
    // of listeners covers every control however the write reaches it.
    await inPage(`(() => {
      window.__ffFirst = new Map();
      window.__ffEvents = 0;
      const note = (event) => {
        window.__ffEvents++;
        const target = event.target;
        const n = target && target.dataset ? target.dataset.n : undefined;
        // The *first* write to each control. Later passes and second events for
        // one write both land here and both are ignored, which is what makes
        // the maximum below the end of the first pass rather than of the run.
        if (n !== undefined && !window.__ffFirst.has(n)) window.__ffFirst.set(n, Date.now());
      };
      document.addEventListener('input', note, true);
      document.addEventListener('change', note, true);
      return true;
    })()`);

    const trigger = JSON.parse(String(await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = ${TAB};
      if (tab === undefined) return JSON.stringify({ at: 0, tabId: -1 });
      const at = Date.now();
      chrome.action.onClicked.dispatch(tab);
      return JSON.stringify({ at, tabId: tab.id });
    })`)));
    const started = trigger.at;
    if (started === 0) throw new Error('no active tab to fill');

    /**
     * Waited on the **badge**, which is set on both endings, and never on the
     * writes going quiet.
     *
     * The background refuses a second fill while a tab is still in `filling`,
     * and only a completed operation or a 15 s timeout clears it. A loop that
     * navigated away as soon as the writes stopped therefore left the tab
     * marked, and every trigger for the next fifteen seconds was ignored — which
     * looked exactly like a fill that ran and wrote nothing: three of nine runs
     * measured, the rest reporting zero controls filled. The badge is the one
     * signal that distinguishes "finished" from "still going", and this is at
     * least the second time in this project that waiting on values instead of on
     * the badge produced a harness that passed by never running.
     *
     * The wait is not part of the number. What is reported is the last *first*
     * write; this only decides when it is safe to stop looking for more.
     */
    let settled = false;
    for (let waited = 0; waited < 200 && !settled; waited++) {
      await sleep(100);
      settled = (await inWorker(
        `chrome.action.getBadgeText({ tabId: ${trigger.tabId} }).then((t) => t !== '')`,
      )) === true;
    }
    if (!settled) {
      const diag = await inWorker(`Promise.all([
        chrome.action.getBadgeText({ tabId: ${trigger.tabId} }),
        chrome.tabs.query({}).then((t) => t.length),
      ]).then((r) => JSON.stringify({ badge: r[0], tabs: r[1] }), (e) => 'threw ' + e.message)`);
      const written = await inPage(`window.__ffFirst ? window.__ffFirst.size : 'no recorder'`);
      throw new Error(`the fill never finished — no badge within 20 s (tabId=${trigger.tabId}, ${diag}, written=${written})`);
    }

    const result = await inPage(`(() => {
      const times = [...window.__ffFirst.values()];
      const controls = [...document.querySelectorAll('[data-n]')];

      /**
       * A control that received no write is not necessarily a control that was
       * missed. A checkbox is decided by a coin flip seeded from the operation,
       * and a box the flip leaves unticked needs no write at all — so it
       * dispatches nothing, and counting it as unfilled understates coverage by
       * about half the boxes on the page. Reported as its own number instead,
       * which is the difference between "the engine skipped 22 controls" and
       * "the engine decided 22 boxes stay unticked".
       */
      const missed = controls.filter((c) => !window.__ffFirst.has(c.dataset.n));
      const undecided = missed.filter((c) => !(c.type === 'checkbox' && c.checked === false));

      return JSON.stringify({
        written: times.length,
        last: times.length === 0 ? 0 : Math.max(...times),
        events: window.__ffEvents,
        controls: controls.length,
        unticked: missed.length - undecided.length,
        undecided: undecided.length,
      });
    })()`);

    const parsed = JSON.parse(String(result));
    return { ...parsed, ms: parsed.last === 0 ? Number.NaN : parsed.last - started };
  };

  console.log(`\n  NFR-001 — ${CONTROLS} controls, ${RUNS} fills, budget ${BUDGET} ms to the end of the first pass\n`);

  const runs = [];
  for (let run = 0; run < RUNS; run++) runs.push(await measure());

  const cold = runs[0];
  const warm = runs.slice(1);
  const sorted = [...warm.map((r) => r.ms)].sort((a, b) => a - b);
  const median = sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)];
  const worst = sorted.length === 0 ? Number.NaN : sorted[sorted.length - 1];

  console.log(`  · cold  (first fill, worker started by the trigger)   ${String(Math.round(cold.ms)).padStart(5)} ms` +
    `   ${cold.written} written + ${cold.unticked} boxes left unticked = ${cold.controls}`);
  console.log(`  · warm  median of ${String(warm.length).padStart(2)}                              ` +
    `${String(Math.round(median)).padStart(5)} ms`);
  console.log(`  · warm  worst of  ${String(warm.length).padStart(2)}                              ` +
    `${String(Math.round(worst)).padStart(5)} ms`);
  console.log(`\n  Every run: ${runs.map((r) => Math.round(r.ms)).join(', ')} ms`);
  console.log(`  Coverage:  ${runs.map((r) => `${r.written}+${r.unticked}/${r.controls}`).join(', ')}` +
    '   (written + boxes the coin flip left unticked)');
  console.log(`  Events dispatched: ${runs.map((r) => r.events).join(', ')} ` +
    `(more than one per control is later passes re-writing, which this number excludes)\n`);

  const short = runs.find((r) => r.undecided > 0);
  if (short !== undefined) {
    console.log(`  ⚠ a run left ${short.undecided} of ${short.controls} controls neither written nor decided, so the time above is`);
    console.log('    the time to do less than the requirement asks. Treat it as not measured.\n');
    process.exitCode = 1;
  } else if (worst <= BUDGET) {
    console.log(`  ✔ ${CONTROLS} controls stay inside the ${BUDGET} ms budget on every warm run\n`);
  } else {
    console.log(`  ✖ the warm worst case is ${Math.round(worst)} ms against a ${BUDGET} ms budget\n`);
  }
} catch (error) {
  console.error(`\n✖ fill-latency spike failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}
