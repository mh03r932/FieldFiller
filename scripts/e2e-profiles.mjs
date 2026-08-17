#!/usr/bin/env node
/**
 * UC-014 to UC-017: authoring a profile through the options page.
 *
 * `tests/profiles.test.ts` decides whether resolution and precedence are
 * *correct*. This decides whether a person can *reach* them — clicking Add,
 * typing a pattern, writing a rule inside a profile, reordering, deleting.
 *
 * **What it cannot do, and why.** A profile is resolved from the tab's address,
 * which the background may read only under `activeTab` — a grant that follows a
 * real user gesture and cannot be synthesised. A harness-triggered fill
 * therefore reads no address and resolves no profile, so "the profile rule won"
 * is not assertable here. It is the same structural gap FR-037's pattern path
 * has, recorded against both. What this asserts instead is the half that is
 * reachable: the profile is authored, stored in the shape the engine reads, and
 * the fill report says which profile applied — including when none did, which is
 * the case a harness can actually produce and the one FR-047 has to answer.
 *
 * The rule editor inside a profile is the other thing worth driving here. It is
 * the same code as the global list, reached through a lens, and the failure it
 * could have is writing to the wrong list — which storage shows and a screenshot
 * would not.
 *
 * Usage: pnpm run build && pnpm run profiles:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'reference.html');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-profiles-'));
let chrome;
let cdp;

const html = readFileSync(FIXTURE, 'utf8');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

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

  const TAB = 'tabs.find((candidate) => candidate.active) ?? tabs[0]';
  const OPTIONS_URL = `chrome-extension://${extensionId}/options.html`;

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

  const storedProfiles = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings?.profiles ?? []))`,
    )));

  const announced = async () =>
    String(await inPage(`document.querySelector('#announcements')?.textContent ?? ''`));

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: OPTIONS_URL }, page);
    await waitFor(
      `(document.querySelector('#profiles')?.children.length ?? 0) > 0`,
      'the profiles section never rendered',
    );
  };

  /** Types into a labelled control inside a scope, the way a user would. */
  const type = async (scope, labelText, value, occurrence = 0) => {
    await inPage(`(() => {
      const fields = [...document.querySelectorAll(${JSON.stringify(scope)} + ' label.field')]
        .filter((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      const field = fields[${String(occurrence)}];
      if (field === undefined) throw new Error('no field labelled ' + ${JSON.stringify(labelText)});
      const input = field.querySelector('input, textarea');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  await openOptions();

  // ── UC-014: create ─────────────────────────────────────────────────────────
  check('an empty profile list explains itself rather than looking broken',
    (await inPage(`(document.querySelector('#profiles p')?.textContent ?? '').length > 20`)) === true,
    `text=${JSON.stringify(await inPage(`document.querySelector('#profiles p')?.textContent ?? ''`))}`);

  await inPage(`document.querySelector('#profiles .profile-add').click()`);
  await sleep(300);

  check('adding a profile opens it for editing',
    (await inPage(`document.querySelector('#profiles .rule-body') !== null`)) === true,
    'no editor appeared');

  check('a new profile is flagged as matching nothing',
    (await inPage(`(document.querySelector('#profiles .problem')?.textContent ?? '')
       .includes('no address patterns')`)) === true,
    `problem text was ${JSON.stringify(await inPage(`document.querySelector('#profiles .problem')?.textContent ?? ''`))}`);

  await type('#profiles', 'Name', 'Staging');
  check('the name reaches storage',
    (await storedProfiles())[0]?.label === 'Staging',
    `stored ${JSON.stringify(await storedProfiles())}`);

  check('and the header follows what was typed, without collapsing the editor',
    (await inPage(`document.querySelector('#profiles .profile-name')?.textContent?.startsWith('Staging')`)) === true
      && (await inPage(`document.querySelector('#profiles .rule-body') !== null`)) === true,
    'the header did not update, or the editor was rebuilt under the caret');

  await inPage(`document.querySelector('#profiles .profile-add-url').click()`);
  await sleep(300);
  await type('#profiles', 'Address pattern', '*.staging.test/*');

  check('the address pattern reaches storage',
    JSON.stringify((await storedProfiles())[0]?.urls) === '["*.staging.test/*"]',
    `stored ${JSON.stringify((await storedProfiles())[0]?.urls)}`);

  check('and the profile stops being flagged once it matches something',
    (await inPage(`document.querySelector('#profiles .rule-flag') === null`)) === true,
    'the profile is still flagged as matching nothing');

  // ── UC-015: a rule inside the profile, through the same editor ─────────────
  await inPage(`document.querySelector('#profiles .profile-rules button.primary').click()`);
  await sleep(300);

  check('a rule can be added inside a profile',
    (await inPage(`document.querySelectorAll('#profiles .profile-rules .rule').length`)) === 1,
    'no rule row appeared inside the profile');

  await type('#profiles .profile-rules', 'Name', 'Scoped rule');
  await type('#profiles .profile-rules', 'Matches', 'short_code');
  await sleep(300);

  const afterRule = await storedProfiles();
  check('the rule is written into the profile, not the global list',
    afterRule[0]?.rules?.length === 1 && afterRule[0].rules[0].label === 'Scoped rule',
    `profile rules = ${JSON.stringify(afterRule[0]?.rules)}`);

  const globalRules = JSON.parse(String(await inWorker(
    `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings?.rules ?? []))`,
  )));
  check('and the global rule list is untouched',
    globalRules.length === 0,
    `global rules = ${JSON.stringify(globalRules)} — the lens wrote to the wrong list`);

  // ── UC-014 A1 / BR-014-2: order is precedence, and it is operable ──────────
  await inPage(`document.querySelector('#profiles .profile-add').click()`);
  await sleep(300);
  // Occurrence 0, not 1: adding a profile opens it and closes the previous one,
  // so there is exactly one Name box on screen — the new profile's. (A rule's
  // name box is also labelled "Name", which is why the helper can take an
  // occurrence at all; it is only needed while a profile *and* one of its rules
  // are open together.)
  await type('#profiles', 'Name', 'Second');
  await sleep(200);

  check('a second profile is appended, not inserted',
    (await storedProfiles()).map((p) => p.label).join(',') === 'Staging,Second',
    `order = ${JSON.stringify((await storedProfiles()).map((p) => p.label))}`);

  await inPage(`(() => {
    const rows = [...document.querySelectorAll('#profiles .rule')];
    const second = rows[1];
    second.querySelector('.rule-order button[data-direction=up]').click();
    return true;
  })()`);
  await sleep(300);

  check('moving a profile up changes the order that decides precedence',
    (await storedProfiles()).map((p) => p.label).join(',') === 'Second,Staging',
    `order = ${JSON.stringify((await storedProfiles()).map((p) => p.label))}`);
  check('and the move is announced',
    (await announced()).includes('position'), `announced "${await announced()}"`);
  /**
   * Focus stays on the profile that moved.
   *
   * Not "on the button that was pressed", which is what this asserted first and
   * was wrong: with two profiles, moving the second one up puts it at the top,
   * where its own up button is disabled. Focus then lands on the sibling by
   * design — the alternative is the body, which for a keyboard user means
   * starting again from the top of the page.
   *
   * So the assertion is the requirement rather than the mechanism: after a move,
   * focus is on a control belonging to the profile that moved (WCAG 2.4.3).
   */
  const focusedProfile = String(await inPage(
    `document.activeElement?.closest('.rule')?.dataset?.profile ?? 'none'`,
  ));
  const movedId = (await storedProfiles())[0]?.id ?? '';
  check('and the focus follows the profile that moved',
    focusedProfile === movedId && focusedProfile !== 'none',
    `focus is on profile ${focusedProfile}, expected ${movedId}`);

  // ── UC-016: delete, confirmed ─────────────────────────────────────────────
  // The confirm is the one place this section departs from the rule editor: a
  // profile can hold an afternoon's work, and an undo offer that lives only as
  // long as the page does is not a proportionate safety net for that.
  await inPage(`window.__confirmed = []; window.confirm = (text) => {
    window.__confirmed.push(text); return false;
  }`);
  await inPage(`[...document.querySelectorAll('#profiles .profile-delete')][1].click()`);
  await sleep(300);

  check('deleting a profile asks first',
    (await inPage(`window.__confirmed.length`)) === 1,
    'no confirmation was requested');
  check('and the question names the profile and how many rules go with it',
    (await inPage(`window.__confirmed[0] ?? ''`)).includes('Staging')
      && (await inPage(`window.__confirmed[0] ?? ''`)).includes('1'),
    `asked "${await inPage(`window.__confirmed[0] ?? ''`)}"`);
  check('and declining keeps the profile',
    (await storedProfiles()).length === 2,
    `${(await storedProfiles()).length} profiles remain after declining`);

  await inPage(`window.confirm = () => true`);
  await inPage(`[...document.querySelectorAll('#profiles .profile-delete')][1].click()`);
  await sleep(300);

  check('confirming deletes it, with its rules',
    (await storedProfiles()).map((p) => p.label).join(',') === 'Second',
    `remaining = ${JSON.stringify((await storedProfiles()).map((p) => p.label))}`);

  // ── UC-017 / FR-047: the report says which profile applied ────────────────
  await cdp.send('Page.navigate', { url: pageUrl }, page);
  await waitForAgent(cdp, workerSession, TAB);
  await inWorker(`chrome.tabs.query({}).then((tabs) =>
    chrome.action.setBadgeText({ tabId: (${TAB}).id, text: '' }))`);
  await inWorker(`chrome.tabs.query({}).then((tabs) => {
    chrome.action.onClicked.dispatch(${TAB});
    return 'ok';
  })`);

  // Waits on the operation closing, not on values appearing — see
  // `e2e-settings.mjs` on why the difference matters.
  let badge = '';
  for (let elapsed = 0; elapsed < 14000 && badge === ''; elapsed += 200) {
    await sleep(200);
    badge = String(await inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.getBadgeText({ tabId: (${TAB}).id }))`));
  }
  if (badge === '') throw new Error('the fill neither completed nor refused within 14 s');

  await openOptions();
  const profileLine = String(await inPage(
    `document.querySelector('#report .report-profile')?.textContent ?? ''`,
  ));

  // Stated rather than silent, and this is the assertion that pins it: a fill
  // that matched no profile must *say so*, because an absent line reads exactly
  // like a build with no profiles at all — and "did my scoped rules run?" is the
  // question FR-047 exists to answer.
  check('the report says which profile applied, even when none did',
    profileLine.length > 0, 'the report has no profile line');
  check('and says so in words rather than by omission',
    profileLine.toLowerCase().includes('no profile'),
    `report line = ${JSON.stringify(profileLine)} — a harness fill cannot be granted activeTab, so no profile can resolve here`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-014..UC-017 — profiles authored through the options page\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ profiles end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a profile can be written, scoped, reordered and deleted, and the fill says which applied\n');
