#!/usr/bin/env node
/**
 * UC-027: a Fake Filler backup migrated, through a real browser.
 *
 * `tests/fakefiller-migrate.test.ts` decides whether the translation is
 * right. This decides whether a person can reach it: the backup is handed
 * to the page's own `<input type="file">` — Base64-wrapped and named as the
 * reference's export would be, because the transport is part of the
 * promise — the report is read off the screen, and the buttons are
 * clicked. What it is really guarding is the wiring around a replacement
 * that crosses *products*: that nothing is written before the second
 * click, that the two lists are visibly separate on screen, and that the
 * importer and the migrator point at each other's files rather than each
 * claiming them or neither.
 *
 * The centrepiece is the whole mapping at once: one realistic backup with
 * every kind of loss in it — a dropped password string, a refused pattern,
 * a disabled profile, a lost email customisation — migrated over a
 * distinct configuration, with storage read back field by field.
 *
 * Usage: pnpm run build && pnpm run migrate:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * A realistic backup: every generator family this translation maps, one
 * loss of each kind, and the reference's documented defaults where they
 * matter. Shaped exactly as `IFakeFillerOptions` (§2.2 of the research),
 * so what is under test is the real file a migrant brings, not a shape
 * invented for the harness.
 */
const BACKUP = {
  version: 1,
  agreeTermsFields: ['agree, terms, conditions'],
  confirmFields: ['confirm, reenter'],
  defaultMaxLength: 20,
  enableContextMenu: true,
  fieldMatchSettings: {
    matchClass: true,
    matchId: true,
    matchLabel: true,
    matchName: true,
    matchPlaceholder: true,
    matchAriaLabel: true,
    matchAriaLabelledBy: true,
  },
  fields: [
    { type: 'email', name: 'Email', match: ['email', 'e-mail'], emailPrefix: 'qa-' },
    { type: 'telephone', name: 'Phone', match: ['phone', 'fax'] },
    { type: 'number', name: 'Age', match: ['age'], min: 18, max: 99 },
    { type: 'alphanumeric', name: 'Serial', match: ['serial'], template: 'LLL-xxx' },
    // The reference never screened a pattern in its life; this one is the
    // likeliest refused pattern a backup will ever carry (BR-027-3).
    { type: 'regex', name: 'Danger', match: ['danger'], template: '(a+)+b' },
  ],
  ignoredFields: ['captcha'],
  ignoreFieldsWithContent: false,
  ignoreHiddenFields: true,
  passwordSettings: { mode: 'defined', password: 'Pa$$w0rd!' },
  profiles: [
    {
      name: 'Staging',
      urlMatch: '.*\\.staging\\.example\\.com.*',
      fields: [{ type: 'username', name: 'User', match: ['user'] }],
    },
  ],
  triggerClickEvents: true,
};

/** The reference's transport: Base64 in a `.txt`, as its export downloads. */
const BACKUP_AS_EXPORTED = Buffer.from(JSON.stringify(BACKUP), 'utf8').toString('base64');
const BACKUP_NAME = 'fake-filler-2026-08-25.txt';

/** What is in force when the migration arrives, so a replacement is observable. */
const OTHER = {
  version: 1,
  locale: 'auto',
  rules: [
    { id: 'kept', label: 'Kept', enabled: true, match: { mode: 'contains', pattern: 'kept' }, generator: { type: 'email' }, fromPersona: true },
  ],
  profiles: [],
  exclusions: { fields: [], domains: [] },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: false,
    maxLengths: {},
    consentKeywords: ['terms'],
    confirmationKeywords: ['confirm'],
  },
  passwords: { length: 16, upper: true, lower: true, digits: true, symbols: true },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-migrate-'));
const filesDir = join(profileDir, 'files');
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

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    await waitFor(
      `document.querySelector('#migrate .migrate-file') !== null`,
      'the migrate section never rendered',
    );
  };

  /** Hands a file to either section's own file input, exactly as a picker would. */
  const choose = async (section, selector, name, contents) => {
    const path = join(filesDir, name);
    writeFileSync(path, contents);
    const { root } = await cdp.send('DOM.getDocument', {}, page);
    const { nodeId } = await cdp.send(
      'DOM.querySelector',
      { nodeId: root.nodeId, selector: `#${section} ${selector}` },
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

  // ── The centrepiece: the whole mapping, migrated over a live page ─────────
  await seed(OTHER);
  await openOptions();
  await choose('migrate', '.migrate-file', BACKUP_NAME, BACKUP_AS_EXPORTED);
  await waitFor(`document.querySelector('#migrate .migrate-plan') !== null`, 'no report appeared for a valid backup');

  check('the report opens focused on the safe action, not on <body> (WCAG 2.4.3)',
    (await inPage(`document.activeElement?.matches('.migrate-cancel') ?? false`)) === true,
    `focused=${JSON.stringify(String(await inPage(`document.activeElement?.className ?? String(document.activeElement)`)))}`);

  const summary = await textOf('#migrate .migrate-summary');
  check('the report names both sides of the replacement, from the Base64 transport (step 2, BR-026-5’s shape)',
    summary.includes('1 rule(s) and 0 profile(s)') && summary.includes('4 rule(s) and 1 profile(s)'),
    `summary=${JSON.stringify(summary)}`);

  // A2's preamble is absent when the version is the documented one: the
  // report leads with it only when there is doubt to state.
  check('no version doubt is manufactured about the documented version (A2)',
    (await inPage(`document.querySelector('#migrate .migrate-version') === null`)) === true,
    `version=${JSON.stringify(await textOf('#migrate .migrate-version'))}`);

  // BR-027-6, said once at the top rather than named on every rule.
  check('the persona sentence is stated once, above the lists (BR-027-6)',
    (await textOf('#migrate .migrate-persona')).includes('still matches the name'),
    `persona=${JSON.stringify(await textOf('#migrate .migrate-persona'))}`);

  const droppedText = await textOf('#migrate .migrate-dropped');
  check('the refused field is named with every pattern that went into the join (BR-027-3)',
    droppedText.includes('Danger') && droppedText.includes('danger') &&
      droppedText.includes('backtrack'),
    `dropped=${JSON.stringify(droppedText)}`);
  check('the defined password string is named as the change it is, not the string itself (A6)',
    droppedText.includes('one chosen string') && !droppedText.includes('Pa$$w0rd!'),
    `dropped=${JSON.stringify(droppedText)}`);

  const notedText = await textOf('#migrate .migrate-noted');
  check('the disabled profile is named with its own regex, in the arriving-changed list (A5)',
    notedText.includes('Staging') && notedText.includes('.*\\.staging\\.example\\.com.*'),
    `noted=${JSON.stringify(notedText)}`);
  check('the lost email customisation is named on the rule the user recognises (A3, FR-056)',
    notedText.includes('Email') && notedText.includes('emailPrefix'),
    `noted=${JSON.stringify(notedText)}`);
  // The two lists are the two promises; on screen they are two headings a
  // reader tells apart at a glance, which is the property the unit tests
  // cannot see.
  check('the two lists are separate on screen, drops before notes (step 5)',
    (await inPage(
      `(() => { const d = document.querySelector('#migrate .migrate-dropped'); const n = document.querySelector('#migrate .migrate-noted'); return d !== null && n !== null && (d.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`,
    )) === true,
    'the drop list and the note list were not two visible lists in that order');

  check('nothing is written while the report is on screen (step 5 before step 7)',
    canonicalState(await stored()) === canonicalState(OTHER),
    'storage changed before the migration was confirmed');

  // ── BR-026-5's liveness for the third consent surface ─────────────────────
  // The summary's "now" half is computed over live settings, and saving
  // renders nothing (the caret's protection) — so until the refresh hook
  // covered this section too, a rule deleted while the report stood open left
  // the report naming a count that was no longer true. Review caught the
  // section missing from both the registry and the pinning test; this is the
  // same liveness check the import preview gets, on the same page.
  await inPage(`(document.querySelector('#migrate .migrate-summary').dataset.mark = 'before', true)`);
  await clickWithGesture(cdp, page, '#rules .rule-delete');
  await sleep(300);

  const liveSummary = await textOf('#migrate .migrate-summary');
  check('a same-page edit while the report is open is reflected in it (BR-026-5’s liveness)',
    liveSummary.includes('0 rule(s)'),
    `summary=${JSON.stringify(liveSummary)}`);
  check('and the summary was patched in place, not rebuilt',
    (await inPage(`document.querySelector('#migrate .migrate-summary').dataset.mark === 'before'`)) === true,
    'the summary element was rebuilt rather than patched');

  await clickWithGesture(cdp, page, '#migrate .migrate-confirm');
  await sleep(500);

  const after = await stored();
  check('the joined alternation is stored, exactly as the reference matched (BR-027-3)',
    after.rules?.some((rule) => rule.match?.pattern === '(?:email)|(?:e-mail)'),
    `rules=${JSON.stringify(after.rules?.map((r) => r.match))}`);
  check('persona-backed migrated rules draw from the fill’s person (BR-027-6)',
    after.rules?.every((rule) => rule.fromPersona === true) === true,
    `fromPersona=${JSON.stringify(after.rules?.map((r) => r.fromPersona))}`);
  check('the refused pattern never reaches storage, where the next fill would run it (A4, NFR-009)',
    !JSON.stringify(after.rules).includes('(a+)+b'),
    `rules=${JSON.stringify(after.rules)}`);
  check('the alphanumeric template is translated into this extension’s grammar',
    after.rules?.some((rule) => rule.generator?.template === '{upper}{upper}{upper}-{digit}{digit}{digit}'),
    `generators=${JSON.stringify(after.rules?.map((r) => r.generator))}`);
  check('the profile arrives with its rule, disabled, with no guessed URL patterns (A5, BR-027-5)',
    after.profiles?.length === 1 && after.profiles[0]?.enabled === false &&
      after.profiles[0]?.urls.length === 0 && after.profiles[0]?.rules.length === 1,
    `profiles=${JSON.stringify(after.profiles)}`);
  check('ignoredFields arrive as regex-mode exclusions',
    JSON.stringify(after.exclusions?.fields) === JSON.stringify([{ mode: 'regex', pattern: 'captcha' }]),
    `exclusions=${JSON.stringify(after.exclusions)}`);
  check('the user’s source toggles are preserved, including class left on (BR-027-7)',
    after.sources?.className === true && after.sources?.name === true,
    `sources=${JSON.stringify(after.sources)}`);
  check('the behaviour switches arrive under their new names',
    after.behaviour?.dispatchEvents === true && after.behaviour?.skipHidden === true,
    `behaviour=${JSON.stringify(after.behaviour)}`);
  check('the keyword lists are split on commas',
    JSON.stringify(after.behaviour?.consentKeywords) === JSON.stringify(['agree', 'terms', 'conditions']),
    `consent=${JSON.stringify(after.behaviour?.consentKeywords)}`);
  check('the password policy arrives at the default, the chosen string having been named as dropped (A6)',
    after.passwords?.length === 16,
    `passwords=${JSON.stringify(after.passwords)}`);

  const ruleList = await textOf('#rules');
  check('the page redraws, so the rule list shows what was migrated',
    ruleList.includes('Serial'), `#rules=${JSON.stringify(ruleList.slice(0, 120))}`);

  const announced = await textOf('#announcements');
  check('and the announcement says what landed, from the file it came from',
    announced.includes('4 rule(s) and 1 profile(s)') && announced.includes(BACKUP_NAME),
    `announcement=${JSON.stringify(announced)}`);

  check('the report is gone once it has been applied',
    (await inPage(`document.querySelector('#migrate .migrate-plan') === null`)) === true,
    'the report stayed on screen after the migration');

  // ── Cancel: a migration that could have happened, and did not (step 6) ────
  await seed(OTHER);
  await openOptions();
  await choose('migrate', '.migrate-file', BACKUP_NAME, BACKUP_AS_EXPORTED);
  await waitFor(`document.querySelector('#migrate .migrate-plan') !== null`, 'no report appeared for the cancel pass');
  await clickWithGesture(cdp, page, '#migrate .migrate-cancel');
  await sleep(200);
  check('cancelling discards the file and changes nothing',
    (await inPage(`document.querySelector('#migrate .migrate-plan') === null`)) === true &&
      canonicalState(await stored()) === canonicalState(OTHER),
    'cancel left the report up, or wrote something');

  // ── The refusals, each with no way past it (ND-13) ────────────────────────
  const refusals = [
    [
      'A1 · neither JSON nor the reference’s Base64',
      'broken.txt',
      'this is not a backup at all',
      'neither JSON nor Fake Filler',
    ],
    [
      'A1 · this extension’s own export',
      'ours.json',
      JSON.stringify(OTHER),
      'Migration is for Fake Filler backups',
    ],
    [
      'A1 · a file with nothing recognisable in it',
      'foreign.json',
      JSON.stringify({ hello: 'world', from: 'somewhere else' }),
      'none of the keys a Fake Filler backup has',
    ],
  ];

  for (const [name, file, contents, expected] of refusals) {
    await openOptions();
    await choose('migrate', '.migrate-file', file, contents);
    await waitFor(`document.querySelector('#migrate .migrate-refused') !== null`, `${name}: no refusal appeared`);

    const said = await textOf('#migrate .migrate-refused');
    check(`${name} is refused, in words that name the cause or the destination`,
      said.includes(expected), `said=${JSON.stringify(said)}`);
    check(`${name} offers no way to proceed anyway (ND-13)`,
      (await inPage(`document.querySelector('#migrate .migrate-confirm') === null`)) === true,
      'a confirm button was offered for a refused file');
    check(`${name} leaves the configuration alone`,
      canonicalState(await stored()) === canonicalState(OTHER), 'storage moved on a refused migration');

    await clickWithGesture(cdp, page, '#migrate .migrate-dismiss');
    await sleep(200);
    check(`${name} can be dismissed, which clears it and writes nothing`,
      (await inPage(`document.querySelector('#migrate .migrate-refused') === null`)) === true,
      'the refusal stayed on screen after dismissing it');
  }

  // ── The mirror: the two surfaces point at each other’s files (A1 ↔ UC-026 A5)
  await openOptions();
  await choose('import', '.import-file', BACKUP_NAME, BACKUP_AS_EXPORTED);
  await waitFor(`document.querySelector('#import .import-refused') !== null`, 'the importer accepted a Fake Filler backup');
  const importSaid = await textOf('#import .import-refused');
  check('a backup fed to the importer is refused by name and pointed at the migration (UC-026 A5, sharpened)',
    importSaid.includes('Fake Filler backup') && importSaid.includes('Migrate from Fake Filler below'),
    `said=${JSON.stringify(importSaid)}`);
  check('and the importer wrote nothing while doing it',
    canonicalState(await stored()) === canonicalState(OTHER),
    'storage changed while the importer was refusing a backup');

  rmSync(filesDir, { recursive: true, force: true });
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-027 — a Fake Filler backup migrated\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ migration end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a migration translates the backup, names every loss before the write, and the two surfaces point at each other’s files\n');
