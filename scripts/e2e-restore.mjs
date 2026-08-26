#!/usr/bin/env node
/**
 * UC-028: the shipped defaults, back over a configuration, through a real
 * browser.
 *
 * `tests/restore.test.ts` decides whether the counts and the already-defaults
 * check are right. This decides whether a person can reach the safety the use
 * case is: the numbers are read off the confirmation on screen, the buttons are
 * clicked, and storage is inspected on both sides of each click. What it is
 * really guarding is the order — that the write does not happen until the
 * second click, that the way back is named before the write rather than after
 * it, and that the page redraws rather than leaving eleven sections describing
 * a configuration that is gone.
 *
 * Usage: pnpm run build && pnpm run restore:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachToWorker,
  canonicalState,
  clickWithGesture,
  closeChromium,
  derivedExtensionId,
  launchChromium,
  sleep,
} from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const rule = (id, extra = {}) => ({
  id,
  label: `Rule ${id}`,
  enabled: true,
  match: { mode: 'contains', pattern: id },
  generator: { type: 'email' },
  fromPersona: true,
  ...extra,
});

/** A configuration with something in every list and something off every default. */
const CONFIGURED = {
  version: 1,
  locale: 'de-CH',
  rules: [rule('kundenstrasse', { label: 'Kundenstraße' }), rule('order')],
  profiles: [
    { id: 'p1', label: 'Staging', enabled: true, urls: ['https://staging.example.com/*'], rules: [rule('p1r1')] },
  ],
  exclusions: { fields: [{ mode: 'exact', pattern: 'coupon' }], domains: ['*.bank.example'] },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: true,
    maxLengths: { textarea: 200 },
    consentKeywords: ['accept'],
    confirmationKeywords: ['confirm'],
  },
  passwords: { length: 20, upper: true, lower: true, digits: true, symbols: false },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

/**
 * The shipped state, restated here rather than imported.
 *
 * A literal on purpose: if the defaults ever change, this harness failing is
 * the reminder that the confirmation's "the value it shipped with" changed too,
 * and that `restoreDone`'s sentence still has to be true of the new ones. A
 * harness that read the defaults from the build could not fail this way — it
 * would agree with whatever shipped, including by mistake.
 */
const DEFAULTS = {
  version: 1,
  locale: 'auto',
  rules: [],
  profiles: [],
  exclusions: { fields: [], domains: [] },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: false,
    maxLengths: {},
    consentKeywords: ['terms', 'conditions', 'privacy', 'policy', 'agree', 'accept', 'consent', 'gdpr'],
    confirmationKeywords: ['confirm', 'verify', 'repeat', 'retype', 'again'],
  },
  passwords: { length: 16, upper: true, lower: true, digits: true, symbols: true },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-restore-'));

let chrome;
let cdp;

const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail });
  if (condition !== true) failures.push(`${name} — ${detail}`);
}

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Runtime.enable', {}, page);

  const workerSession = await attachToWorker(cdp, extensionId);

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

  const waitFor = async (expression, whatFailed) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inPage(expression)) === true) return;
      await sleep(100);
    }
    throw new Error(`${whatFailed} (waited 10 s for \`${expression}\`)`);
  };

  const stored = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings ?? null))`,
    )));

  const seed = async (settings) =>
    inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);

  const textOf = async (selector) =>
    String(await inPage(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`));

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    await waitFor(
      `document.querySelector('#restore .restore-button') !== null`,
      'the restore section never rendered',
    );
  };

  // ── Steps 2 and 3: counts and the way back, before anything is written ─────
  await seed(CONFIGURED);
  await openOptions();
  await clickWithGesture(cdp, page, '#restore .restore-button');
  await waitFor(`document.querySelector('#restore .restore-plan') !== null`, 'no confirmation appeared');

  check('opening the confirmation moves the focus onto the safe action',
    (await inPage(`document.activeElement?.matches('.restore-cancel') ?? false`)) === true,
    `focused=${JSON.stringify(String(await inPage(`document.activeElement?.className ?? String(document.activeElement)`)))}`);

  const summary = await textOf('#restore .restore-summary');
  check('the confirmation names every count of what will be discarded (BR-028-2)',
    summary.includes('2 rule(s)') && summary.includes('1 profile(s)') &&
      summary.includes('1 field exclusion(s)') && summary.includes('1 domain exclusion(s)'),
    `summary=${JSON.stringify(summary)}`);

  const noUndo = await textOf('#restore .restore-no-undo');
  check('and names the way back before the write, not after it (BR-028-5)',
    noUndo.toLowerCase().includes('no undo') && noUndo.includes('Export'),
    `noUndo=${JSON.stringify(noUndo)}`);

  check('nothing is written while the confirmation is on screen (step 4 before step 5)',
    canonicalState(await stored()) === canonicalState(CONFIGURED),
    'storage changed before the restore was confirmed');

  // ── A1: cancel ─────────────────────────────────────────────────────────────
  await clickWithGesture(cdp, page, '#restore .restore-cancel');
  await sleep(200);
  check('cancelling closes the confirmation and writes nothing (A1)',
    (await inPage(`document.querySelector('#restore .restore-plan') === null`)) === true &&
      canonicalState(await stored()) === canonicalState(CONFIGURED),
    'cancel left the confirmation up, or wrote something');

  const cancelled = await textOf('#announcements');
  check('the cancellation is announced as leaving the settings unchanged',
    cancelled.toLowerCase().includes('unchanged'), `announcement=${JSON.stringify(cancelled)}`);

  // ── Steps 5 and 6: one write, the shipped state ────────────────────────────
  await clickWithGesture(cdp, page, '#restore .restore-button');
  await waitFor(`document.querySelector('#restore .restore-confirm') !== null`, 'no confirmation on the second attempt');
  await clickWithGesture(cdp, page, '#restore .restore-confirm');
  await sleep(500);

  check('confirming writes the shipped defaults as one replacement (BR-028-1)',
    canonicalState(await stored()) === canonicalState(DEFAULTS),
    `stored=${canonicalState(await stored())}`);

  const ruleList = await textOf('#rules');
  check('the page redraws, so the rule list shows what is gone',
    !ruleList.includes('Kundenstraße'), `#rules=${JSON.stringify(ruleList.slice(0, 120))}`);

  const announced = await textOf('#announcements');
  check('and the announcement says what landed (step 6)',
    announced.toLowerCase().includes('shipped defaults'), `announcement=${JSON.stringify(announced)}`);

  check('the confirmation is gone once it has been applied',
    (await inPage(`document.querySelector('#restore .restore-plan') === null`)) === true,
    'the confirmation stayed on screen after the restore');

  // ── A2 and BR-028-4: nothing to discard is a state, not an error ────────────
  // Reached on the shipped state the last block wrote, which is the point: the
  // restore just ran, and the honest confirmation about restoring again says
  // there is nothing to discard — not a refusal, and not a disabled button.
  await clickWithGesture(cdp, page, '#restore .restore-button');
  await waitFor(`document.querySelector('#restore .restore-already') !== null`, 'a defaults-only configuration was not named as one (A2)');

  const already = await textOf('#restore .restore-already');
  check('a defaults-only configuration is told it is one, in the confirmation (A2)',
    already.toLowerCase().includes('already'), `already=${JSON.stringify(already)}`);

  await clickWithGesture(cdp, page, '#restore .restore-confirm');
  await sleep(500);
  check('and the restore is still offered, and still works (BR-028-4)',
    canonicalState(await stored()) === canonicalState(DEFAULTS),
    `stored=${canonicalState(await stored())}`);

  // ── Same-page edits while the confirmation is open ─────────────────────────
  // The one writer the storage listener never reports back as foreign: this
  // page itself. Saving renders nothing — the caret's protection — so the
  // confirmation used to keep the counts from whenever it was opened: a third
  // rule added while it read two was discarded as two, and a defaults-only
  // page could say "this changes nothing" over a password length it was about
  // to discard. Found in review before merge, and driven here exactly as
  // reported. Storage is the shipped state the last block wrote, which is the
  // sharper variant's precondition.
  await clickWithGesture(cdp, page, '#restore .restore-button');
  await waitFor(
    `document.querySelector('#restore .restore-already') !== null`,
    'the sharper variant needs an already-defaults line to be made false',
  );

  // Marked so a patch can be told from a rebuild: a rebuild destroys the
  // marked element, a patch leaves it standing.
  await inPage(`(document.querySelector('#restore .restore-plan').dataset.mark = 'before', true)`);

  // The sharper variant's edit: one scalar, in another section, with the
  // confirmation standing open over it.
  await inPage(`(() => {
    const input = document.querySelector('#passwords input[type="number"]');
    input.value = '20';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);

  check('a same-page edit removes the "changes nothing" line it made false (BR-028-2)',
    (await inPage(`document.querySelector('#restore .restore-already') === null`)) === true &&
      (await inPage(`document.querySelector('#restore .restore-plan') !== null`)) === true,
    'the already-defaults line survived an edit that made it false, or the confirmation closed');
  check('and it was patched in place, not rebuilt',
    (await inPage(`document.querySelector('#restore .restore-plan').dataset.mark === 'before'`)) === true,
    'the confirmation was rebuilt rather than patched');

  // The counted variant: a field exclusion with a real pattern, added through
  // the section's own controls while the confirmation stays open. A blank row
  // would not do — the parser drops blanks, so nothing would move.
  await clickWithGesture(cdp, page, '#field-exclusions button.primary');
  await inPage(`(() => {
    const input = document.querySelector('#field-exclusions [data-exclusion="0"] input[type="text"]');
    input.value = 'coupon';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);

  const liveSummary = await textOf('#restore .restore-summary');
  check('a counted edit made while the confirmation is open is reflected in it (BR-028-2)',
    liveSummary.includes('1 field exclusion(s)'),
    `summary=${JSON.stringify(liveSummary)}`);

  // And the write discards exactly what the now-honest screen names: the
  // password length, the exclusion, nothing else.
  await clickWithGesture(cdp, page, '#restore .restore-confirm');
  await sleep(500);
  check('confirming after same-page edits discards what the screen came to name',
    canonicalState(await stored()) === canonicalState(DEFAULTS),
    `stored=${canonicalState(await stored())}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-028 — the shipped defaults, restored over a configuration\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ restore end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a restore says what it will discard, writes only on a second click, and lands the shipped state\n');
