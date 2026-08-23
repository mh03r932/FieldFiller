#!/usr/bin/env node
/**
 * UC-026: a configuration read back in from a file, through a real browser.
 *
 * `tests/settings-import.test.ts` decides whether the analysis is right. This
 * decides whether a person can reach it: the file is handed to the page's own
 * `<input type="file">`, the preview is read off the screen, and the buttons are
 * clicked. What it is really guarding is the wiring around an operation that
 * replaces everything — that the write does not happen until the second click,
 * that a refusal offers no way past itself, and that the page redraws afterwards
 * rather than leaving eight sections describing a configuration that is gone.
 *
 * The centrepiece is the round trip: a configuration is exported through UC-025
 * and imported back through UC-026, and the assertion is that storage ends up
 * holding what it held before. The two use cases are one format seen from both
 * ends, and this is the only place that claim is tested as a whole rather than
 * as two halves that agree with the same unit test.
 *
 * Usage: pnpm run build && pnpm run import:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The configuration that gets exported, then imported back over a different one. */
const ORIGINAL = {
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

/** What is in force when the import arrives, so a replacement is observable. */
const OTHER = { ...ORIGINAL, locale: 'auto', rules: [rule('something-else')], profiles: [] };

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-import-'));
const downloadDir = join(profileDir, 'downloads');
const filesDir = join(profileDir, 'files');
mkdirSync(downloadDir, { recursive: true });
mkdirSync(filesDir, { recursive: true });

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
  await cdp.send('DOM.enable', {}, page);

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

  // The round trip below exports a real file first, so downloads have to land
  // somewhere this harness can read. `allow` keeps the extension's own filename,
  // which is what makes the file recognisable in the directory listing.
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    await waitFor(
      `document.querySelector('#import .import-file') !== null`,
      'the import section never rendered',
    );
  };

  /**
   * Hands a file to the page's own file input.
   *
   * `DOM.setFileInputFiles` is the only way in: a file input's `files` is not
   * writable from script, which is the browser refusing to let a page choose a
   * file for the user. It fires the input's `change` event exactly as a picker
   * would, so what runs afterwards is the page's own handler.
   */
  const choose = async (name, contents) => {
    const path = join(filesDir, name);
    writeFileSync(path, contents);
    const { root } = await cdp.send('DOM.getDocument', {}, page);
    const { nodeId } = await cdp.send(
      'DOM.querySelector',
      { nodeId: root.nodeId, selector: '#import .import-file' },
      page,
    );
    await cdp.send('DOM.setFileInputFiles', { files: [path], nodeId }, page);
  };

  const stored = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings ?? null))`,
    )));

  const seed = async (settings) =>
    inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);

  const textOf = async (selector) =>
    String(await inPage(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`));

  // ── The round trip: out through UC-025, back through UC-026 ────────────────
  await seed(ORIGINAL);
  await openOptions();
  await clickWithGesture(cdp, page, '#export .export-file');
  for (let attempt = 0; attempt < 100 && readdirSync(downloadDir).length === 0; attempt++) await sleep(100);
  const exportedName = readdirSync(downloadDir).find((name) => !name.endsWith('.crdownload'));
  if (exportedName === undefined) throw new Error('the export wrote no file to import back');
  const exported = readFileSync(join(downloadDir, exportedName), 'utf8');

  // A different configuration is in force, so a replacement is visible rather
  // than being indistinguishable from doing nothing at all.
  await seed(OTHER);
  await openOptions();
  await choose('round-trip.json', exported);
  await waitFor(`document.querySelector('#import .import-plan') !== null`, 'no preview appeared for a valid file');

  const summary = await textOf('#import .import-summary');
  check('the preview names both sides of the replacement (BR-026-5)',
    summary.includes('1 rule(s) and 0 profile(s)') && summary.includes('2 rule(s) and 1 profile(s)'),
    `summary=${JSON.stringify(summary)}`);

  check('a clean file drops nothing',
    (await inPage(`document.querySelector('#import .import-dropped') === null`)) === true,
    `dropped=${JSON.stringify(await textOf('#import .import-dropped'))}`);

  check('nothing is written while the preview is on screen (step 5 before step 7)',
    canonicalState(await stored()) === canonicalState(OTHER),
    'storage changed before the import was confirmed');

  await clickWithGesture(cdp, page, '#import .import-confirm');
  await sleep(500);

  check('a configuration survives the round trip out and back (UC-025 + UC-026)',
    canonicalState(await stored()) === canonicalState(ORIGINAL),
    `stored=${canonicalState(await stored())}`);

  const ruleList = await textOf('#rules');
  check('the page redraws, so the rule list shows what was imported',
    ruleList.includes('Kundenstraße'), `#rules=${JSON.stringify(ruleList.slice(0, 120))}`);

  const announced = await textOf('#announcements');
  check('and the announcement says what landed',
    announced.includes('round-trip.json'), `announcement=${JSON.stringify(announced)}`);

  check('the preview is gone once it has been applied',
    (await inPage(`document.querySelector('#import .import-plan') === null`)) === true,
    'the preview stayed on screen after the import');

  // ── A6 and BR-026-7: what will not be kept, named before the write ─────────
  await seed(OTHER);
  await openOptions();
  await choose('lossy.json', JSON.stringify({
    version: 1,
    rules: [rule('kept'), { label: 'Broken rule', match: { mode: 'contains', pattern: 'x' } }],
    behaviour: { wobble: 3 },
    exclusions: 3,
    somethingElse: true,
  }));
  await waitFor(`document.querySelector('#import .import-dropped') !== null`, 'nothing was reported as dropped');

  const droppedText = await textOf('#import .import-dropped');
  check('a rule the parser cannot read is named, by its own label (A6)',
    droppedText.includes('Broken rule'), `dropped=${JSON.stringify(droppedText)}`);
  check('an unknown key is named by path (BR-026-7)',
    droppedText.includes('behaviour.wobble') && droppedText.includes('somethingElse'),
    `dropped=${JSON.stringify(droppedText)}`);
  // The silent one. A section the parser answers with defaults reports nothing
  // of its own — no unknown key, no unreadable entry — so if the shape check
  // ever stops running, this file imports as clean and takes the user's
  // exclusions with it.
  check('a section that is not a section is named too (UC-026 step 4)',
    droppedText.includes('exclusions'), `dropped=${JSON.stringify(droppedText)}`);
  check('and it is said before the write, not after (BR-026-3)',
    canonicalState(await stored()) === canonicalState(OTHER),
    'storage changed while the drop report was still a preview');

  // ── Cancel ────────────────────────────────────────────────────────────────
  await clickWithGesture(cdp, page, '#import .import-cancel');
  await sleep(200);
  check('cancelling discards the file and changes nothing',
    (await inPage(`document.querySelector('#import .import-plan') === null`)) === true &&
      canonicalState(await stored()) === canonicalState(OTHER),
    'cancel left the preview up, or wrote something');

  // ── The refusals, each with no way past it (BR-026-2) ──────────────────────
  const refusals = [
    ['A1 · not JSON', 'broken.json', '{ not json', 'not JSON'],
    ['A1 · JSON that is not an object', 'array.json', '[1, 2, 3]', 'single JSON object'],
    ['A2 · a newer schema', 'newer.json', JSON.stringify({ ...ORIGINAL, version: 2 }), 'newer version'],
    [
      'A5 · nothing in it is ours',
      'other-tool.json',
      JSON.stringify({ fields: [{ type: 'text', name: 'email' }], ignoredFields: ['captcha'] }),
      'Nothing in that file',
    ],
  ];

  for (const [name, file, contents, expected] of refusals) {
    await openOptions();
    await choose(file, contents);
    await waitFor(`document.querySelector('#import .import-refused') !== null`, `${name}: no refusal appeared`);

    const said = await textOf('#import .import-refused');
    check(`${name} is refused, in words that name the cause`,
      said.includes(expected), `said=${JSON.stringify(said)}`);
    check(`${name} offers no way to proceed anyway (BR-026-2)`,
      (await inPage(`document.querySelector('#import .import-confirm') === null`)) === true,
      'a confirm button was offered for a refused file');
    check(`${name} leaves the configuration alone`,
      canonicalState(await stored()) === canonicalState(OTHER), 'storage moved on a refused import');
  }

  // A2 names both versions, which is what tells the user the fix is an update.
  await openOptions();
  await choose('newer-again.json', JSON.stringify({ ...ORIGINAL, version: 2 }));
  await waitFor(`document.querySelector('#import .import-refused') !== null`, 'no refusal for a newer file');
  const newerSaid = await textOf('#import .import-refused');
  check('the newer-schema refusal names both versions and rules out editing the file (A2)',
    newerSaid.includes('2') && newerSaid.includes('1') && newerSaid.includes('Do not change the version'),
    `said=${JSON.stringify(newerSaid)}`);

  // ── A5 is the one that would otherwise look like a success ────────────────
  // Stated as its own check because it is the failure every other part of the
  // system would call fine: the parse succeeds, the write succeeds, and the
  // user's configuration is replaced by defaults.
  const afterForeignFile = await stored();
  check('a file from another tool does not silently become an empty configuration (BR-026-4)',
    Array.isArray(afterForeignFile.rules) && afterForeignFile.rules.length === 1,
    `rules=${JSON.stringify(afterForeignFile.rules)}`);

  rmSync(filesDir, { recursive: true, force: true });
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-026 — a configuration imported from a file\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ import end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ an import replaces the configuration, says what it will do first, and refuses what is not ours\n');
