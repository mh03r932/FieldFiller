#!/usr/bin/env node
/**
 * The measurement DD-009 step C is gated on.
 *
 * `docs/implementation_plan.md` does not schedule the combobox ladder; it gates
 * it. Finding a custom combobox means looking for `role="combobox"`,
 * `role="listbox"` and `aria-haspopup="listbox"`, which widens the walk's
 * candidate selector on **every** page — including the overwhelming majority
 * that have no such control — so the cost lands on NFR-001's per-fill budget
 * everywhere while the benefit lands on a minority. Per `vision.md` §3 reaching
 * further is coverage rather than correctness, so this is the part of DD-009
 * that yields if the number is bad.
 *
 * What is measured, per page shape:
 *
 *   · **candidates found** by the shipped selector and by the widened one, so
 *     the inflation is a count and not an impression;
 *   · **walk time**, as the walk really runs it — the candidate query *plus* the
 *     `*` scan that finds shadow hosts. Timing the selector alone would flatter
 *     the widened version by hiding it behind a cost the walk already pays.
 *
 * Four shapes, chosen so that the answer cannot come out favourable by accident:
 * the two real fixtures, a heavy application page with **no** comboboxes at all
 * (the case that pays and does not benefit), and a design-system page where an
 * eighth of the controls are comboboxes (the case that benefits).
 *
 * No extension is loaded. This measures the DOM, which is where the cost is.
 *
 * Usage: node scripts/spike-combobox.mjs
 *   CHROME_PATH=…  override the browser binary
 *   RUNS=…         samples per measurement (default 21)
 *   HEADFUL=1      show the window
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.env['RUNS'] ?? 21);

/**
 * Walks per timing sample.
 *
 * `performance.now()` is coarsened to 100 microseconds in a page context, as a
 * side-channel defence. One walk of a small page falls inside a single bucket,
 * so it reports either 0 or 0.1 ms and both selectors look identical — which is
 * an artefact of the clock, not a finding about the selector.
 */
const BATCH = Number(process.env['BATCH'] ?? 50);

/** Kept in step with `src/lib/page/walk.ts`. */
const SHIPPED = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * What step C would add. `role="combobox"` on an `<input>` is already matched by
 * `input`, and a comma-separated `querySelectorAll` returns each element once,
 * so the new candidates are only the non-native ones.
 */
const WIDENED = `${SHIPPED}, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"]`;

/** NFR-001. The walk is one part of this; the question is what part. */
const FILL_BUDGET_MS = 500;

/**
 * A page shaped like an application rather than like a form.
 *
 * 500 fillable controls is NFR-001's figure, and they sit inside the wrapper
 * depth a component framework really produces — because the walk's `*` scan is
 * linear in *every* element, not in the fillable ones, and a fixture made only
 * of inputs would measure a DOM nobody has.
 *
 * `comboboxes` are ARIA ones on `<div>`s, which is what the widened selector
 * newly finds. At zero this is the page that pays for step C and gets nothing.
 */
function applicationPage({ controls, comboboxes }) {
  const parts = [];
  for (let index = 0; index < controls; index++) {
    const isCombobox = index < comboboxes;
    const field = isCombobox
      ? `<div role="combobox" tabindex="0" aria-expanded="false" aria-haspopup="listbox"
              aria-labelledby="l${index}"><span>Select…</span></div>
         <input type="hidden" name="f${index}">`
      : `<input name="f${index}" placeholder="Field ${index}">`;

    // Five wrappers per field, each carrying the class and data attributes a
    // component library emits. Selector matching walks these too.
    parts.push(`
      <div class="Field Field--outlined" data-testid="field-${index}">
        <div class="Field__root"><div class="Field__control"><div class="Field__inner">
          <span class="Field__adornment" aria-hidden="true"></span>
          <label class="Field__label" id="l${index}">Field ${index}</label>
          ${field}
        </div></div></div>
      </div>`);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>synthetic application page</title></head><body>
    <div id="app"><header role="banner"><nav role="navigation"><ul>${
      Array.from({ length: 40 }, (_, n) => `<li><a href="#s${n}">Section ${n}</a></li>`).join('')
    }</ul></nav></header><main role="main"><form>${parts.join('')}</form></main></div>
    </body></html>`;
}

const PAGES = {
  'reference fixture': readFileSync(join(ROOT, 'tests', 'fixtures', 'reference.html'), 'utf8'),
  'cascade fixture': readFileSync(join(ROOT, 'tests', 'fixtures', 'cascade.html'), 'utf8'),
  'application page, 500 controls, no combobox': applicationPage({ controls: 500, comboboxes: 0 }),
  'design system, 500 controls, 60 comboboxes': applicationPage({ controls: 500, comboboxes: 60 }),
};

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let chrome;
let cdp;
let fatal;
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-combobox-'));
const measurements = [];

let serving = '';
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(serving);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  // No extension: this spike measures how third-party combobox widgets behave,
  // not how we fill them, so it wants a plain browser.
  ({ chrome, cdp } = await launchChromium(undefined, profileDir));

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Runtime.enable', {}, page);

  for (const [name, html] of Object.entries(PAGES)) {
    serving = html;
    await cdp.send('Page.navigate', { url: `${origin}/?${encodeURIComponent(name)}` }, page);
    await sleep(700);

    const measured = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const SHIPPED = ${JSON.stringify(SHIPPED)};
        const WIDENED = ${JSON.stringify(WIDENED)};

        // The walk as it really runs: the candidate query, then the '*' scan
        // that finds shadow hosts. Both are in the budget, and the second is
        // what the first has to be judged against.
        const walk = (selector) => {
          const found = document.querySelectorAll(selector).length;
          let hosts = 0;
          for (const element of document.querySelectorAll('*')) {
            if (element.shadowRoot !== null) hosts++;
          }
          // Returned so neither half can be optimised away as dead.
          return found + hosts;
        };

        // A batch per sample, then divided back out. The page clock is
        // deliberately coarsened -- 100 microsecond buckets -- so timing one
        // walk of a small page reports zero, and the comparison becomes "both
        // are nothing", which is not a measurement.
        const BATCH = ${BATCH};
        const sample = (selector) => {
          const times = [];
          for (let run = 0; run < ${RUNS}; run++) {
            const before = performance.now();
            for (let repeat = 0; repeat < BATCH; repeat++) walk(selector);
            times.push((performance.now() - before) / BATCH);
          }
          return times;
        };

        // Warm the JIT and the selector caches equally for both, so the first
        // one measured is not penalised for being first.
        sample(SHIPPED); sample(WIDENED);

        const shipped = document.querySelectorAll(SHIPPED);
        const widened = document.querySelectorAll(WIDENED);
        const added = [...widened].filter((element) => ![...shipped].includes(element));

        return {
          elements: document.querySelectorAll('*').length,
          shippedCount: shipped.length,
          widenedCount: widened.length,
          addedTags: [...new Set(added.map((element) =>
            element.tagName.toLowerCase() + (element.getAttribute('role') ? '[role=' + element.getAttribute('role') + ']' : '')))],
          shippedTimes: sample(SHIPPED),
          widenedTimes: sample(WIDENED),
        };
      })())`,
      returnByValue: true,
    }, page);

    const seen = JSON.parse(measured.result.value);
    measurements.push({ name, ...seen });
  }
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
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

if (fatal !== undefined) {
  console.error(`\n✖ combobox spike could not run: ${fatal}`);
  process.exit(1);
}

console.log('\n  DD-009 step C — what widening the walk selector costs\n');
console.log(`  ${RUNS} samples of ${BATCH} walks each, median reported.` +
  ` Walk = candidate query + shadow-host scan.\n`);

for (const entry of measurements) {
  const shipped = median(entry.shippedTimes);
  const widened = median(entry.widenedTimes);
  const delta = widened - shipped;
  const share = (delta / FILL_BUDGET_MS) * 100;

  console.log(`  ${entry.name}`);
  console.log(`    ${entry.elements} elements · candidates ${entry.shippedCount} → ${entry.widenedCount}` +
    ` (+${entry.widenedCount - entry.shippedCount})`);
  if (entry.addedTags.length > 0) console.log(`    newly matched: ${entry.addedTags.join(', ')}`);
  console.log(`    walk ${shipped.toFixed(3)} ms → ${widened.toFixed(3)} ms` +
    `  (${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ms, ${share.toFixed(2)}% of NFR-001's ${FILL_BUDGET_MS} ms)`);
  console.log('');
}

console.log('  The number that decides step C is the third page: an application with 500');
console.log('  controls and no combobox anywhere, which pays the whole cost and gets nothing.\n');
