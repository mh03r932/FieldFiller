#!/usr/bin/env node
/**
 * The scoreboard for DD-009.
 *
 * `e2e-chrome.mjs` asks whether the engine fills a page that holds still. This
 * asks whether it can fill a page that answers back — the cases in UC-034's
 * alternative flows, each one a shape that exists in the wild and that a
 * single-pass fill gets wrong.
 *
 * **It is expectation-based, and passes while the expectations hold.** A run
 * where every case behaves exactly as recorded exits 0, whether that behaviour
 * is a pass or a known-unbuilt failure. Three things make it exit 1:
 *
 *   · a case expected to pass that now fails — a regression;
 *   · a case expected to fail that now passes — the step that fixes it has
 *     landed, and its expectation is stale;
 *   · the fill not running at all, which otherwise looks like every case failing
 *     for its own reason.
 *
 * So this harness could be committed and run in CI before any of DD-009 existed,
 * and each of its three steps announced itself by flipping rows from `fail` to
 * `pass`. **All three have now landed (2026-08-15), every row is expected to
 * pass, and the table has stopped being a progress bar and become a regression
 * gate.** It keeps its shape rather than collapsing into plain assertions,
 * because the second exit condition is still worth having: a row that starts
 * passing on its own is a capability nobody recorded.
 *
 * Usage: node scripts/e2e-cascade.mjs   (after `pnpm run build`)
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachToWorker, closeChromium, derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'cascade.html');

/**
 * What each case does *today*, on the single-pass engine.
 *
 * `pass` — works now, and must keep working. `fail` — the defect DD-009 exists
 * to fix; the step named is the one expected to flip it.
 *
 * Editing a row here is the deliberate act of claiming a step has landed. Do it
 * in the same change as the code, never ahead of it.
 */
const EXPECTED = {
  // The eight rows below flipped on 2026-08-15 with the fixpoint loop. They are
  // now the regression suite for it: any of them going back to `fail` means the
  // loop stopped following the page.
  'c1 · dependent select filled from its rewritten options': { now: 'pass', fixedBy: undefined },
  'c2 · chained cascade settles all three levels': { now: 'pass', fixedBy: undefined },
  'c3 · debounced cascade is waited for': { now: 'pass', fixedBy: undefined },
  'c4 · fields revealed by an answer are filled': { now: 'pass', fixedBy: undefined },
  'c5 · control enabled by an answer is filled': { now: 'pass', fixedBy: undefined },
  'c6 · a property-only wipe is noticed': { now: 'pass', fixedBy: undefined },
  'c7 · a page that always reverts still terminates the fill': { now: 'pass', fixedBy: undefined },
  'c8 · a replaced control ends up holding a value': { now: 'pass', fixedBy: undefined },
  'c9 · a reformatted value counts as filled': { now: 'pass', fixedBy: undefined },
  'c9 · a normalised number counts as filled': { now: 'pass', fixedBy: undefined },
  // Landed 2026-08-15 with the ladder. The row below it is what stops the ladder
  // from being "improved" into writing the hidden input, which would pass this
  // one and lie about the page.
  'c10 · a custom combobox is answered': { now: 'pass', fixedBy: undefined },
  'c10 · the hidden carrier was not written directly': { now: 'pass', fixedBy: undefined },
  'report · filled count does not exceed what the page holds': { now: 'pass', fixedBy: undefined },
  'report · every value the page holds was claimed by the report': { now: 'pass', fixedBy: undefined },
  'report · the field the page will not let us fill is reported as a failure': { now: 'pass', fixedBy: undefined },
  'report · the fixture settles rather than stopping at a bound': { now: 'pass', fixedBy: undefined },
};

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-cascade-'));
let chrome;
let cdp;
let fatal;

const html = readFileSync(FIXTURE, 'utf8');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

/** case name → true when the observed page satisfies it. */
const results = new Map();

/** The report's arithmetic, printed each run so the honesty gap is visible. */
let counts;

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Runtime.enable', {}, page);
  await cdp.send('Page.navigate', { url: pageUrl }, page);

  const workerSession = await attachToWorker(cdp, extensionId);

  // Readiness as a condition, not a sleep. A fixed 1500 ms here was the thinnest
  // margin in this harness: ample on an idle machine, and on a loaded shared
  // runner short enough that the fill below could be triggered into a page whose
  // agent was not yet listening — which fails as "the fill did not run",
  // correctly diagnosed, but a flake all the same. The protocol's own ping is
  // the exact condition the sleep approximated: a `pong` means the page agent is
  // injected and listening in the tab about to be filled (the agent registers at
  // `document_idle`, which Chrome may place immediately *after* the load event,
  // so `readyState` alone would not prove it). Until it is listening,
  // `sendMessage` rejects — "receiving end does not exist" — and the poll
  // retries. The tab is identified the same way the trigger below identifies it.
  let agentReady = false;
  for (let attempt = 0; attempt < 100 && !agentReady; attempt++) {
    const pinged = await cdp.send('Runtime.evaluate', {
      expression: `chrome.tabs.query({}).then((tabs) => {
        const tab = tabs.length === 1 ? tabs[0] : tabs.find((candidate) => candidate.active);
        if (tab === undefined) return 'no tab among ' + tabs.length;
        return chrome.tabs.sendMessage(tab.id, { kind: 'ping' })
          .then((reply) => reply !== undefined && reply.kind === 'pong'
            ? 'pong'
            : 'answered without a pong: ' + JSON.stringify(reply))
          .catch(() => 'not listening yet');
      })`,
      awaitPromise: true, returnByValue: true,
    }, workerSession);
    agentReady = pinged.result.value === 'pong';
    if (!agentReady) await sleep(100);
  }
  if (!agentReady) throw new Error('the page agent never answered a ping within 10 s of navigation');

  const triggered = await cdp.send('Runtime.evaluate', {
    expression: `chrome.tabs.query({}).then((tabs) => {
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
  if (!outcome.startsWith('ok:')) throw new Error(`the toolbar trigger did not fire — ${outcome}`);

  // Long enough for the slowest thing on the page (c3's 350 ms debounce) plus
  // the settle window, and then some. A generous wait is right here: the point
  // is to give the *engine* every chance, so that a failure below is the
  // engine's and not the clock's.
  //
  // The badge is sampled *during* the wait, not after it. It reverts three
  // seconds after it is set (DD-006), so a single read once the wait is over
  // reliably finds it already cleared — which silently turns the overcount check
  // into `0 <= holding` and makes it pass for the wrong reason. That is exactly
  // how the first run of this harness scored a case it had not tested.
  let badge = '';
  let badgeColour = '';
  let badgeTitle = '';
  for (let elapsed = 0; elapsed < 4500; elapsed += 150) {
    await sleep(150);
    if (badge === '') {
      const read = await cdp.send('Runtime.evaluate', {
        expression: `chrome.tabs.query({}).then(async (tabs) => {
          const tabId = tabs[0].id;
          const text = await chrome.action.getBadgeText({ tabId });
          const colour = await chrome.action.getBadgeBackgroundColor({ tabId });
          const title = await chrome.action.getTitle({ tabId });
          return [text, Array.isArray(colour) ? colour.join(',') : '', title].join('|');
        })`,
        awaitPromise: true, returnByValue: true,
      }, workerSession);
      [badge, badgeColour, badgeTitle] = String(read.result.value ?? '||').split('|');
    }
  }

  const observed = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const value = (name) => {
        const el = document.querySelector('[name="' + name + '"]');
        if (el === null) return null;
        return el.value;
      };
      const present = (name) => document.querySelector('[name="' + name + '"]') !== null;

      // Everything the engine could legitimately have filled, and whether it
      // holds anything. Disabled, hidden and read-only controls are excluded the
      // way UC-005 excludes them, so the count is comparable with the report.
      let holding = 0;
      let fillable = 0;
      for (const el of document.querySelectorAll('input, select, textarea')) {
        if (el.disabled || el.readOnly || el.type === 'hidden') continue;
        if (el.closest('[hidden]') !== null) continue;
        fillable++;
        if (String(el.value ?? '') !== '') holding++;
      }

      // A custom combobox is a control the engine can fill and the page can
      // hold an answer in, and it is none of the three tags above — so without
      // this the arithmetic counts step C's successes as an overcount. It has
      // no readable value either: what it holds is what it displays, and the
      // only way to tell an answer from a placeholder is to know the fixture's
      // placeholder, which this harness does because it owns the fixture.
      for (const el of document.querySelectorAll('[role="combobox"]')) {
        if (el.getAttribute('aria-disabled') === 'true') continue;
        if (el.closest('[hidden]') !== null) continue;
        fillable++;
        if (el.textContent.trim() !== 'Select…') holding++;
      }

      return {
        c1_country: value('c1_country'), c1_county: value('c1_county'),
        c2_region: value('c2_region'), c2_district: value('c2_district'), c2_ward: value('c2_ward'),
        c3_carrier: value('c3_carrier'), c3_service: value('c3_service'),
        c4_type: value('c4_type'), c4_company: value('c4_company'), c4_vat: value('c4_vat'),
        c4_revealed: document.getElementById('c4-extra').hidden === false,
        c5_plan: value('c5_plan'), c5_seats: value('c5_seats'),
        c5_seats_enabled: document.querySelector('[name="c5_seats"]').disabled === false,
        c6_reference: value('c6_reference'),
        c7_coupon: value('c7_coupon'),
        c8_delivery: value('c8_delivery'), c8_present: present('c8_delivery'),
        c9_reference: value('c9_reference'), c9_quantity: value('c9_quantity'),
        c10_currency: value('c10_currency'),
        c10_display: document.getElementById('c10-display').textContent,
        holding, fillable,
      };
    })())`,
    returnByValue: true,
  }, page);

  const seen = JSON.parse(observed.result.value);

  // A fill that never ran makes every case fail for a reason that has nothing to
  // do with the case. Diagnosed as itself.
  if (seen.c1_country === '' && seen.c9_quantity === '') {
    throw new Error('nothing was filled at all — this is not a cascade failure, the fill did not run');
  }

  counts = { badge: badge === '' ? '—' : Number(badge), holding: seen.holding, fillable: seen.fillable };

  const record = (name, condition, detail) => results.set(name, { ok: Boolean(condition), detail });

  record('c1 · dependent select filled from its rewritten options',
    seen.c1_county !== '' && seen.c1_county !== null, `c1_county=${JSON.stringify(seen.c1_county)}`);

  record('c2 · chained cascade settles all three levels',
    seen.c2_district !== '' && seen.c2_ward !== '',
    `district=${JSON.stringify(seen.c2_district)} ward=${JSON.stringify(seen.c2_ward)}`);

  record('c3 · debounced cascade is waited for',
    seen.c3_service !== '', `c3_service=${JSON.stringify(seen.c3_service)}`);

  record('c4 · fields revealed by an answer are filled',
    seen.c4_revealed && seen.c4_company !== '' && seen.c4_vat !== '',
    `revealed=${seen.c4_revealed} company=${JSON.stringify(seen.c4_company)}`);

  record('c5 · control enabled by an answer is filled',
    seen.c5_seats_enabled && seen.c5_seats !== '',
    `enabled=${seen.c5_seats_enabled} seats=${JSON.stringify(seen.c5_seats)}`);

  record('c6 · a property-only wipe is noticed',
    seen.c6_reference !== '', `c6_reference=${JSON.stringify(seen.c6_reference)}`);

  // This field cannot end up holding a value — the page will not permit it, and
  // that is the case, not a defect. What is asserted here is *termination*: a
  // badge appeared at all, so the fill ended rather than fighting the page
  // forever. It passes today because a single-pass fill has nothing to loop
  // with, and step B is where it becomes load-bearing: an unbounded fixpoint
  // loop on this page never reports, and this row is what would catch it.
  //
  // Whether the reverted field was *counted* is the report row's job, below. Two
  // rows asserting the same number would just fail together and say it twice.
  record('c7 · a page that always reverts still terminates the fill',
    seen.c7_coupon === '' && badge !== '',
    `coupon=${JSON.stringify(seen.c7_coupon)} badge=${JSON.stringify(badge)}`);

  record('c8 · a replaced control ends up holding a value',
    seen.c8_present && seen.c8_delivery !== '', `c8_delivery=${JSON.stringify(seen.c8_delivery)}`);

  // BR-034-4. These two must not regress when verification lands: a rewritten
  // reference and a normalised number were accepted, not rejected. They are the
  // guard against verification-by-string-equality, which would report a
  // correctly filled page as a wall of failures.
  record('c9 · a reformatted value counts as filled',
    typeof seen.c9_reference === 'string' && seen.c9_reference !== '' &&
      seen.c9_reference === seen.c9_reference.toUpperCase(),
    `c9_reference=${JSON.stringify(seen.c9_reference)}`);
  record('c9 · a normalised number counts as filled',
    seen.c9_quantity !== '' && Number(seen.c9_quantity) >= 1 && Number(seen.c9_quantity) <= 99,
    `c9_quantity=${JSON.stringify(seen.c9_quantity)}`);

  record('c10 · a custom combobox is answered',
    seen.c10_currency !== '' && seen.c10_display !== 'Select…',
    `carrier=${JSON.stringify(seen.c10_currency)} shows=${JSON.stringify(seen.c10_display)}`);

  // BR-034-9, and it must hold *now*: writing the hidden carrier is the shortcut
  // that looks like success and submits a lie. This passes today only because
  // hidden inputs are excluded by kind, and it must never stop passing.
  record('c10 · the hidden carrier was not written directly',
    seen.c10_currency === '' || seen.c10_display !== 'Select…',
    `carrier=${JSON.stringify(seen.c10_currency)} shows=${JSON.stringify(seen.c10_display)}`);

  // The report's honesty, in one subtraction — and it is asserted in both
  // directions, because the two errors are opposite lies with different causes.
  //
  // The badge counts what the engine says it filled; `holding` counts what the
  // page actually holds. Claiming *more* is the silent failure UC-034 exists to
  // remove: a control the page reverted, reported as though it had not been.
  // Claiming *fewer* is the loop dropping outcomes — a frame closed too early, a
  // control tracked twice and reported once, a pass whose results were lost.
  // Neither is visible in any single case row, and both are visible here.
  //
  // Progress recorded: 10 claimed against 7 held before FR-076, 9 against 7
  // after step A, and 16 against 16 with the loop. The two that went away with
  // the loop are c6's property wipe at 120 ms and c8's node replacement at
  // 100 ms — both asynchronous, and both invisible to a check made at the moment
  // of writing.
  record('report · filled count does not exceed what the page holds',
    badge !== '' && Number(badge) <= seen.holding,
    `badge=${badge} holding=${seen.holding} of ${seen.fillable} fillable`);

  record('report · every value the page holds was claimed by the report',
    badge !== '' && Number(badge) >= seen.holding,
    `badge=${badge} holding=${seen.holding} of ${seen.fillable} fillable`);

  // c7 cannot be filled — the page will not permit it — so the honest result is
  // a reported failure, not a quiet omission. The badge turns red when anything
  // failed, which is the only signal this harness can see into; without this row
  // a loop that silently dropped its unfillable controls would score a perfect
  // page. `#c0392b` is the failure colour in `background.ts`.
  record('report · the field the page will not let us fill is reported as a failure',
    badgeColour === '192,57,43,255',
    `badge colour=${JSON.stringify(badgeColour)}, expected the failure colour 192,57,43,255`);

  // Every case above can pass on a fill that *stopped at its cap* — the fields
  // get filled either way, and only the report knows the difference. This is the
  // row that keeps the bounds honest: the fixture is a page the engine can
  // settle, so a run that reports it as capped means the pass cap has been
  // reduced below the depth the matrix actually needs. It is what turned "the
  // matrix settles in three" into the measurement that it needs four.
  record('report · the fixture settles rather than stopping at a bound',
    badgeTitle !== '' && !badgeTitle.includes('may be stale'),
    `action title=${JSON.stringify(badgeTitle)}`);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

if (fatal !== undefined) {
  console.error(`\n✖ cascade harness could not run: ${fatal}`);
  process.exit(1);
}

// ── Scoreboard ───────────────────────────────────────────────────────────────
const regressions = [];
const advances = [];
let asExpected = 0;

console.log('\n  UC-034 — dependent fields, against the current engine\n');
if (counts !== undefined) {
  // Printed every run, not only on failure. The report's honesty is one
  // subtraction, and it is the number that moves as DD-009 lands.
  console.log(
    `  report: ${counts.badge} claimed filled · ${counts.holding} holding a value` +
      ` · ${counts.fillable} fillable\n`,
  );
}
for (const [name, expectation] of Object.entries(EXPECTED)) {
  const result = results.get(name);
  if (result === undefined) {
    regressions.push(`${name} — the harness produced no result for this case`);
    continue;
  }

  const expectedPass = expectation.now === 'pass';
  if (result.ok === expectedPass) {
    asExpected++;
    const mark = result.ok ? '✔' : '·';
    const note = result.ok ? '' : `   (expected — step ${expectation.fixedBy})`;
    console.log(`  ${mark} ${name}${note}`);
    continue;
  }

  if (expectedPass) {
    regressions.push(`${name} — ${result.detail}`);
    console.log(`  ✖ ${name}   REGRESSED`);
  } else {
    advances.push(`${name} — step ${expectation.fixedBy} appears to have landed`);
    console.log(`  ★ ${name}   NOW PASSES`);
  }
}

const failing = [...results.values()].filter((result) => !result.ok).length;
console.log(
  `\n  ${results.size - failing}/${results.size} passing · ${asExpected} as expected` +
    `${regressions.length > 0 ? ` · ${regressions.length} regressed` : ''}` +
    `${advances.length > 0 ? ` · ${advances.length} newly passing` : ''}`,
);

if (regressions.length > 0) {
  console.error('\n✖ regressions — these worked before:\n');
  for (const entry of regressions) console.error(`    ${entry}`);
}
if (advances.length > 0) {
  console.error('\n★ these now pass. Update EXPECTED in this file, in the same change:\n');
  for (const entry of advances) console.error(`    ${entry}`);
}

if (regressions.length > 0 || advances.length > 0) process.exit(1);

console.log('\n✔ the cascade fixture behaves exactly as recorded');
