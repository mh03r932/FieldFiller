#!/usr/bin/env node
/**
 * UC-025: a configuration leaving as a file, through a real browser.
 *
 * `tests/settings-file.test.ts` decides whether the *bytes* are right. This
 * decides whether they ever reach a file — which is a different question with
 * different failure modes, and every one of them is invisible to a unit test:
 * an anchor the browser declines to act on, an object URL revoked before the
 * download reads it, a file that lands under the wrong name, or a second export
 * that differs from the first because something in the path is not as
 * deterministic as the serialiser is.
 *
 * The `downloads` permission is what makes this worth its own harness rather
 * than a line in `e2e-options.mjs`. NFR-008 forbids it and BR-025-2 accepts the
 * consequence: the file leaves through an anchor and an object URL created in
 * the options page. That is a path with more ways to fail silently than the API
 * would have had, so it is checked by watching a file appear on disk — with the
 * manifest asserted to still lack the permission in the same run, so the two
 * halves of the claim cannot drift apart.
 *
 * Usage: pnpm run build && pnpm run export:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachToWorker, closeChromium, derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

/**
 * The configuration the file has to survive carrying.
 *
 * Not the defaults: a file of defaults would pass every assertion below while
 * dropping every rule, and "the export works" would mean nothing. Two rules
 * because one of them inherits its sources and the other pins them, a profile
 * because profiles are the section most recently added to the schema, and a
 * label with an ß because BR-025-4 is a promise about exactly that and this is
 * the only place it can be checked as *bytes on disk* rather than as a string in
 * memory.
 */
const SEEDED = {
  version: 1,
  locale: 'de-CH',
  rules: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Kundenstraße',
      enabled: true,
      match: { mode: 'contains', pattern: 'strasse' },
      generator: { type: 'name', part: 'first' },
      fromPersona: true,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Order reference',
      enabled: true,
      match: { mode: 'regex', pattern: '^order' },
      sources: ['name', 'label'],
      generator: { type: 'alphanumeric', template: 'AA-999' },
      fromPersona: false,
    },
  ],
  profiles: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      label: 'Staging',
      enabled: true,
      urls: ['https://staging.example.com/*'],
      rules: [],
    },
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
  sources: { name: true, id: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-export-'));
const downloadDir = join(profileDir, 'downloads');
mkdirSync(downloadDir, { recursive: true });

let chrome;
let cdp;

const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail });
  if (condition !== true) failures.push(`${name} — ${detail}`);
}

/**
 * Files the browser has finished writing.
 *
 * `.crdownload` is Chromium's in-progress name, so a file still carrying it is
 * one the harness would otherwise read half of — and a half-written file
 * compares unequal to a whole one, which would have read as BR-025-3 failing.
 */
function completedDownloads() {
  return readdirSync(downloadDir).filter((name) => !name.endsWith('.crdownload')).sort();
}

async function waitForDownloads(count, whatFailed) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (completedDownloads().length >= count) return completedDownloads();
    await sleep(100);
  }
  throw new Error(`${whatFailed} (waited 10 s; saw ${JSON.stringify(completedDownloads())})`);
}

/**
 * A state compared by content rather than by its serialisation.
 *
 * `chrome.storage.local` hands back an object whose keys are in *alphabetical*
 * order, not the order they were written in — measured here, not assumed, when
 * this comparison was first written as a string compare and failed against a
 * state nothing had touched. It is also the sharpest argument for UC-025's
 * serialiser restating the schema's key order itself (BR-025-3): every
 * configuration this extension exports has been through storage, so an export
 * that stringified what it read would emit alphabetised keys today and
 * whatever a future storage backend prefers tomorrow.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

  /**
   * A click the browser counts as a gesture.
   *
   * `element.click()` is what the other harnesses use and it is enough
   * everywhere they use it. Here it is not: Chromium allows one download from a
   * page that has seen no user interaction and silently blocks the rest, so the
   * second export — the one BR-025-3 is asserted on — wrote no file at all and
   * read as the export being broken. Dispatching the press and release puts the
   * gesture where the browser looks for it, and is what a person does anyway.
   */
  const clickWithGesture = async (selector) => {
    const at = await inPage(
      '(() => {' +
        'const element = document.querySelector(' + JSON.stringify(selector) + ');' +
        'if (element === null) return null;' +
        "element.scrollIntoView({ block: 'center' });" +
        'const box = element.getBoundingClientRect();' +
        'return { x: box.left + box.width / 2, y: box.top + box.height / 2 };' +
      '})()',
    );
    if (at === null) throw new Error(`nothing to click for \`${selector}\``);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'left', clickCount: 1 },
        page,
      );
    }
  };

  const waitFor = async (expression, whatFailed) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inPage(expression)) === true) return;
      await sleep(100);
    }
    throw new Error(`${whatFailed} (waited 10 s for \`${expression}\`)`);
  };

  // Downloads go somewhere this harness can read, rather than to the profile's
  // default directory. `allow` rather than `allowAndName`: the name is part of
  // what UC-025 step 4 promises, and `allowAndName` replaces it with a GUID.
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    // The rendered child, not the static container — `#export` is in
    // `index.html` and exists before the script that fills it has run.
    await waitFor(
      `document.querySelector('#export .export-file') !== null`,
      'the export section never rendered',
    );
  };

  /**
   * One export, from an empty download directory.
   *
   * Emptied first because `Browser.setDownloadBehavior` gives every download the
   * same target path: a second export of the same configuration *overwrites*
   * the first rather than landing beside it as `… (1).json`, which is the
   * browser's own uniquifying being bypassed by the harness rather than
   * anything the extension did. Measured, after the byte-identical check spent
   * ten seconds waiting for a second file that had already been written over
   * the first. Clearing the directory makes each export observable on its own
   * terms — and the BR-025-3 comparison is then between two files written from
   * scratch, which is the stronger form of the claim anyway.
   */
  const exportOnce = async (whatFailed) => {
    for (const name of readdirSync(downloadDir)) rmSync(join(downloadDir, name));
    await clickWithGesture('#export .export-file');
    const [name] = await waitForDownloads(1, whatFailed);
    return { name, bytes: readFileSync(join(downloadDir, name)) };
  };

  // ── The manifest half of BR-025-2, asserted in the same run ────────────────
  const permissions = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).permissions;
  check('the build asks for no downloads permission (BR-025-2, NFR-008)',
    Array.isArray(permissions) && !permissions.includes('downloads'),
    `permissions=${JSON.stringify(permissions)}`);

  // ── A configured state, then an export ─────────────────────────────────────
  await inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(SEEDED)} }).then(() => true)`);
  await openOptions();

  const first = await exportOnce('no file was written by the export');
  check('the file is named for the extension and the schema version (step 4)',
    first.name === 'fieldfiller-settings-v1.json', `name=${first.name}`);

  const exported = JSON.parse(first.bytes.toString('utf8'));

  check('every section is in the file (BR-025-1)',
    JSON.stringify(Object.keys(exported)) ===
      JSON.stringify(['version', 'locale', 'rules', 'profiles', 'exclusions', 'behaviour',
        'passwords', 'sources', 'triggers']),
    `keys=${JSON.stringify(Object.keys(exported))}`);

  check('the rules the user wrote are in it, in their order',
    JSON.stringify(exported.rules?.map((rule) => rule.label)) ===
      JSON.stringify(['Kundenstraße', 'Order reference']),
    `labels=${JSON.stringify(exported.rules?.map((rule) => rule.label))}`);

  check('the profile came with them',
    exported.profiles?.[0]?.label === 'Staging', `profiles=${JSON.stringify(exported.profiles)}`);

  check('an inheriting rule is still inheriting in the file (FR-067)',
    exported.rules?.[0] !== undefined && !('sources' in exported.rules[0]) &&
      JSON.stringify(exported.rules?.[1]?.sources) === JSON.stringify(['name', 'label']),
    `sources=${JSON.stringify(exported.rules?.map((rule) => rule.sources ?? 'inherited'))}`);

  // Bytes, not the parsed value: `JSON.parse` turns `\u00df` back into an ß, so
  // an assertion on the parsed string would pass against exactly the escaped
  // file BR-025-4 forbids.
  check('non-ASCII text is in the file as itself, not as escapes (BR-025-4)',
    first.bytes.includes(Buffer.from('Kundenstraße', 'utf8')) &&
      !first.bytes.includes(Buffer.from('\\u00df')),
    'the ß was escaped, or the label is missing');

  check('the file is pretty-printed and ends in a newline (BR-025-4)',
    first.bytes.toString('utf8').startsWith('{\n  "version": 1,') &&
      first.bytes.toString('utf8').endsWith('}\n'),
    `head=${JSON.stringify(first.bytes.toString('utf8').slice(0, 32))}`);

  check('no password is in the file, only the policy (BR-025-5)',
    JSON.stringify(Object.keys(exported.passwords ?? {})) ===
      JSON.stringify(['length', 'upper', 'lower', 'digits', 'symbols']),
    `passwords=${JSON.stringify(exported.passwords)}`);

  const stored = JSON.parse(String(await inWorker(
    `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings))`,
  )));
  check('an export changes nothing (success postcondition)',
    canonical(stored) === canonical(SEEDED), `stored=${canonical(stored)}`);

  check('the announcement names the file that was offered',
    String(await inPage(`document.querySelector('#announcements')?.textContent ?? ''`))
      .includes('fieldfiller-settings-v1.json'),
    `announcement=${JSON.stringify(await inPage(`document.querySelector('#announcements')?.textContent ?? ''`))}`);

  check('and the section says on its face what the file holds (A1)',
    (await inPage(`(document.querySelector('#export .hint')?.textContent ?? '').length > 20`)) === true,
    'no note on the export section about what the file holds');

  // ── BR-025-3, the property the whole file exists for ───────────────────────
  // A fresh page between the two, so the claim is that the bytes depend on the
  // configuration and on nothing this page accumulated since it loaded.
  await openOptions();
  const second = await exportOnce('the second export wrote no file');

  check('re-exporting an unchanged configuration is byte-identical (BR-025-3)',
    first.bytes.equals(second.bytes),
    `${first.bytes.length} B vs ${second.bytes.length} B`);

  // ── A1: the file is the stored state, not the screen ───────────────────────
  // Add makes a rule in the page's memory with an empty pattern; the tolerant
  // parser drops it on the way into storage, so the screen legitimately shows
  // one more rule than storage holds. That is A1's situation exactly, produced
  // the way a user produces it, and the assertion is that the file follows
  // storage rather than the list in front of them.
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);

  const onScreen = await inPage(`document.querySelectorAll('#rules .rule-name').length`);
  check('the unsaved rule really is on screen (A1 precondition)',
    onScreen === 3, `rule rows on screen=${onScreen}`);

  const third = JSON.parse((await exportOnce('the third export wrote no file')).bytes.toString('utf8'));
  check('an edit that has not been saved is not in the file (A1)',
    third.rules?.length === 2, `rules in file=${third.rules?.length}, on screen=${onScreen}`);

  // ── A3: nothing configured yet ─────────────────────────────────────────────
  await inWorker(`chrome.storage.local.clear().then(() => true)`);
  await openOptions();
  const defaults = JSON.parse(
    (await exportOnce('exporting an unconfigured extension wrote no file')).bytes.toString('utf8'),
  );

  check('an unconfigured extension exports a complete configuration, not an empty one (A3)',
    Object.keys(defaults).length === 9 && Array.isArray(defaults.rules) && defaults.rules.length === 0,
    `keys=${JSON.stringify(Object.keys(defaults))}, rules=${JSON.stringify(defaults.rules)}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-025 — a configuration exported to a file\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ export end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ the stored configuration reaches a file, byte for byte, with no downloads permission\n');
