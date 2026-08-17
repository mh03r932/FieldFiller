#!/usr/bin/env node
/**
 * UC-018 to UC-023: the Phase 4 settings screens, end to end.
 *
 * The companion to `e2e-options.mjs`, which covers the rule editor. The split is
 * by screen rather than by size: that one drives a list with an open item, a
 * draft and an undo, and this one drives six forms over a flat schema.
 *
 * What makes this worth running is the second half of each check. Every setting
 * here was in the schema before it was authored anywhere, and three of them —
 * the password policy, the per-kind length caps, the two keyword lists — were
 * read by nothing at all: storage held them and the fill ignored them. So an
 * assertion that the checkbox stored `false` proves nothing worth knowing. Each
 * section is therefore driven through the UI and then *observed on a filled
 * page*, which is the only claim a user would recognise.
 *
 * Usage: pnpm run build && pnpm run settings:chrome
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
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-settings-'));
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

  const stored = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings ?? null))`,
    )));

  const announced = async () =>
    String(await inPage(`document.querySelector('#announcements')?.textContent ?? ''`));

  /** Ticks or unticks a checkbox by its visible label, inside one section. */
  const toggle = async (sectionId, labelText, checked) => {
    await inPage(`(() => {
      const label = [...document.querySelectorAll('#${sectionId} label.check')]
        .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(labelText)}));
      if (label === undefined) throw new Error('no checkbox labelled ' + ${JSON.stringify(labelText)});
      const box = label.querySelector('input[type=checkbox]');
      if (box.checked === ${JSON.stringify(checked)}) return true;
      // Clicked rather than assigned. A click is what a person does, and it is
      // also the only form that fires the event the handler listens for.
      box.click();
      return true;
    })()`);
    await sleep(200);
  };

  /** Types into a labelled text control inside one section. */
  const type = async (sectionId, labelText, value) => {
    await inPage(`(() => {
      const field = [...document.querySelectorAll('#${sectionId} label.field')]
        .find((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      if (field === undefined) throw new Error('no field labelled ' + ${JSON.stringify(labelText)});
      const input = field.querySelector('input, textarea');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  /** Chooses a value in the one select a section has. */
  const choose = async (sectionId, value) => {
    await inPage(`(() => {
      const control = document.querySelector('#${sectionId} select');
      if (control === null) throw new Error('no select in #${sectionId}');
      control.value = ${JSON.stringify(value)};
      if (control.value !== ${JSON.stringify(value)}) {
        throw new Error('no option ' + ${JSON.stringify(value)} + ' in #${sectionId}');
      }
      // Assigned then dispatched: a select is not clicked open from script, and
      // change is the event the handler listens for.
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: OPTIONS_URL }, page);
    // The condition has to be something a *render* produces. `#triggers` is
    // static markup and exists the instant the document parses, so waiting on it
    // would return before the script that fills it has run.
    await waitFor(
      `(document.querySelector('#triggers')?.children.length ?? 0) > 0`,
      'the settings sections never rendered',
    );
  };

  const badgeState = async () =>
    JSON.parse(String(await inWorker(`chrome.tabs.query({}).then(async (tabs) => {
      const tab = ${TAB};
      return JSON.stringify({
        text: await chrome.action.getBadgeText({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }),
      });
    })`)));

  /**
   * Fills the fixture with the toolbar trigger and returns what landed.
   *
   * The whole point of this harness. Everything above it is a checkbox; this is
   * whether the checkbox meant anything.
   *
   * **Waits for the operation to close, not for the values to appear**, and the
   * difference is not pedantry. Values land several hundred milliseconds before
   * the fill is over — the settle window is still open and the frames have not
   * reported — so returning on the first non-empty field and navigating away
   * leaves the operation with no report ever arriving. The background then holds
   * that tab in `filling` for its full 15-second timeout and *silently ignores*
   * every later trigger on it (UC-001 A7).
   *
   * Which is exactly what happened here: the domain-exclusion fill at the end of
   * this file never ran at all, and the check that the page was not filled went
   * green on an empty form. A harness that can pass by nothing happening is
   * worse than no harness, because it is evidence pointing the wrong way.
   *
   * The badge is the signal because it is the one thing set on *both* endings —
   * a count when the fill completes, `off` when it is refused — so one condition
   * covers both and neither can be mistaken for a fill that never started.
   */
  const fillAndRead = async (fields) => {
    await cdp.send('Page.navigate', { url: pageUrl }, page);
    await waitForAgent(cdp, workerSession, TAB);
    // Cleared first, so what is read below belongs to this fill. Navigation
    // clears it too, but on its own terms — waiting on someone else's clear is
    // how a stale mark gets read as a fresh one.
    // Parenthesised: `??` binds looser than a property access, so `${TAB}.id`
    // reads as `tabs.find(…) ?? tabs[0].id` and passes a whole tab as an id.
    await inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.setBadgeText({ tabId: (${TAB}).id, text: '' }))`);

    const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = ${TAB};
      if (tab === undefined) return 'no tab';
      chrome.action.onClicked.dispatch(tab);
      return 'ok';
    }).catch((error) => 'threw: ' + error.message)`);
    if (fired !== 'ok') throw new Error(`the toolbar trigger did not fire — ${String(fired)}`);

    let badge = await badgeState();
    for (let elapsed = 0; elapsed < 14000 && badge.text === ''; elapsed += 200) {
      await sleep(200);
      badge = await badgeState();
    }
    if (badge.text === '') throw new Error('the fill neither completed nor refused within 14 s');

    const values = JSON.parse(String(await inPage(`JSON.stringify(Object.fromEntries(
      ${JSON.stringify(fields)}.map((name) =>
        [name, document.querySelector('[name=' + name + ']')?.value ?? ''])))`)));
    return { ...values, badge };
  };

  await openOptions();

  // ── UC-018: the global matching sources ────────────────────────────────────
  check('every section renders',
    (await inPage(`['general','sources','field-exclusions','domain-exclusions','behaviour','passwords','triggers']
       .every((id) => (document.querySelector('#' + id)?.children.length ?? 0) > 0)`)) === true,
    'at least one section rendered nothing');

  // Read off the screen, not out of storage. A fresh profile has never been
  // written to — the extension stores nothing until the user changes something —
  // so `chrome.storage.local` is empty here and the defaults exist only as the
  // state the page rendered from. Asking storage what shipped would be asking
  // the one place that does not know.
  check('the class source ships off',
    (await inPage(`[...document.querySelectorAll('#sources label.check')]
       .find((label) => label.textContent.trim().startsWith('CSS class'))
       ?.querySelector('input').checked`)) === false,
    'the class checkbox is ticked on a fresh profile');

  // Two in a row, and that is the point. Six checkboxes share one section and
  // nothing re-renders between two clicks, so a handler holding the state it was
  // built with computes the second tick from before the first — and the first is
  // silently lost. It is the defect the rule editor was fixed for, reachable
  // here in two clicks.
  await toggle('sources', 'CSS class', true);
  await toggle('sources', 'Placeholder', false);
  const afterTwo = (await stored()).sources;
  check('two source toggles in a row both survive',
    afterTwo.className === true && afterTwo.placeholder === false,
    `sources=${JSON.stringify(afterTwo)} — one of the two clicks was computed from a stale snapshot`);

  check('switching a source is announced',
    (await announced()).length > 0, `announced "${await announced()}"`);

  check('the count beneath the boxes follows the boxes',
    (await inPage(`(document.querySelector('#sources .source-count')?.textContent ?? '').includes('5')`)) === true,
    `count reads ${JSON.stringify(await inPage(`document.querySelector('#sources .source-count')?.textContent ?? ''`))}`);

  // Put them back, so nothing downstream is filled through a changed source set.
  await toggle('sources', 'CSS class', false);
  await toggle('sources', 'Placeholder', true);

  // ── UC-019 + UC-022: policy and caps, observed on a filled page ────────────
  await type('passwords', 'Length', '20');
  await toggle('passwords', 'Symbols', false);
  await toggle('passwords', 'Uppercase letters', false);

  check('the sample follows the policy',
    (await inPage(`/^[a-z0-9]{20}$/.test(
       document.querySelector('#passwords .samples')?.textContent ?? '')`)) === true,
    `sample=${JSON.stringify(await inPage(`document.querySelector('#passwords .samples')?.textContent ?? ''`))}`);

  /**
   * The length box cannot put a value in memory that storage would clamp.
   *
   * BR-019-5 says the sample is drawn from the real generator and cannot drift
   * from it, and this is the one way it could: the page holds settings in memory
   * un-normalised, storage normalises on the way in, and the page decides whose
   * write an echo was by comparing both sides *through the parser* — so a value
   * the parser clamps comes back looking like this page's own work and is never
   * adopted. A length of 0 then rendered an empty sample beside fills that used
   * the stored length, until a reload. Clearing the box is the ordinary way to
   * reach it: `Number('')` is 0.
   */
  await type('passwords', 'Length', '');
  check('clearing the length box does not store a length no fill would use',
    (await stored()).passwords.length === 20,
    `stored ${(await stored()).passwords.length} after the box was cleared`);
  check('and the sample still shows what a fill would produce',
    (await inPage(`/^[a-z0-9]{20}$/.test(
       document.querySelector('#passwords .samples')?.textContent ?? '')`)) === true,
    `sample=${JSON.stringify(await inPage(`document.querySelector('#passwords .samples')?.textContent ?? ''`))}`);

  await type('passwords', 'Length', '9999');
  check('and a length past what storage accepts is refused rather than clamped behind the user',
    (await stored()).passwords.length === 20,
    `stored ${(await stored()).passwords.length} for a length of 9999`);

  // Back to the policy the checks below describe.
  await type('passwords', 'Length', '20');

  await type('behaviour', 'Text area', '25');

  // ── ND-1: the locale, and what it must not take with it ────────────────────
  // The section with a single control, and therefore the one that never
  // re-renders itself: its handler holds the state the page opened with. Every
  // setting changed above was changed *after* that, so a save computed from that
  // snapshot reverts all of them — in memory and in storage — and nothing on
  // screen says a word about it. Driven here rather than in the sections above
  // because the defect needs two sections and an order: change something, then
  // change the locale, then look at the something.
  await choose('general', 'de-CH');
  const afterLocale = await stored();
  check('changing the locale does not revert settings changed since the page opened',
    afterLocale.locale === 'de-CH' &&
      afterLocale.passwords.length === 20 &&
      afterLocale.passwords.symbols === false,
    `stored locale=${JSON.stringify(afterLocale.locale)} passwords=${JSON.stringify(afterLocale.passwords)}` +
      ' — the locale save was computed from a stale snapshot');

  // Back to the shipped default, so the fills below draw from the corpus every
  // other check in this file assumes. A second change from the same handler,
  // which is also the two-in-a-row case the sources section is checked for.
  await choose('general', 'auto');
  const afterRestore = await stored();
  check('and neither does changing it back',
    afterRestore.locale === 'auto' && afterRestore.passwords.length === 20,
    `stored locale=${JSON.stringify(afterRestore.locale)} passwords=${JSON.stringify(afterRestore.passwords)}`);

  const filled = await fillAndRead(['password', 'notes', 'pw', 'pw_second']);

  check('a password field receives the configured length',
    filled.password.length === 20, `password was ${filled.password.length} characters`);
  check('and only the character classes that are ticked',
    /^[a-z0-9]+$/.test(filled.password),
    `password=${JSON.stringify(filled.password)} — a class the policy excludes came back`);
  check('a confirmation field still matches, under a policy',
    filled.pw === filled.pw_second && filled.pw.length > 0,
    `pw=${JSON.stringify(filled.pw)} pw_second=${JSON.stringify(filled.pw_second)}`);
  check('a textarea with no maxlength honours the configured cap',
    filled.notes.length === 25, `notes was ${filled.notes.length} characters`);

  // ── UC-022: consent keywords, observed on a filled page ────────────────────
  /**
   * What the fill said about one control, from DD-006's report.
   *
   * Read rather than inspecting the checkbox, and the difference decides whether
   * this check means anything. A checkbox with no keyword and no `required` is a
   * *coin flip* (`checkbox → random`), so asserting it came out unticked is a
   * 50% assertion: it would have gone green half the time with the keyword list
   * wired to nothing, which is precisely the defect it exists to catch. The
   * provenance says which rule decided, so it is the same question asked in a
   * form that has one answer.
   */
  const provenanceFor = async (identityFragment) => {
    await openOptions();
    return String(await inPage(`(() => {
      const row = [...document.querySelectorAll('#report tbody tr')]
        .find((tr) => (tr.querySelector('th')?.textContent ?? '')
          .toLowerCase().includes(${JSON.stringify(identityFragment.toLowerCase())}));
      return row?.querySelector('.detail')?.textContent ?? 'no row';
    })()`));
  };

  await fillAndRead(['password']);
  check('a consent box is ticked because it is one, not by luck',
    (await provenanceFor('terms')).includes('consent'),
    `the report says "${await provenanceFor('terms')}"`);

  await type('behaviour', 'Consent keywords', 'nothing-here-matches');
  check('the keyword list is stored as lines, blanks dropped',
    JSON.stringify((await stored()).behaviour.consentKeywords) === '["nothing-here-matches"]',
    `stored ${JSON.stringify((await stored()).behaviour.consentKeywords)}`);

  await fillAndRead(['password']);
  check('and stops being treated as consent once its keyword is gone',
    (await provenanceFor('terms')).includes('random'),
    `the report says "${await provenanceFor('terms')}" — the keyword list did not reach the fill`);

  // ── UC-020: a field exclusion, observed on a filled page ───────────────────
  await openOptions();
  await inPage(`document.querySelector('#field-exclusions button.primary').click()`);
  await sleep(300);
  check('adding an exclusion puts the focus in its pattern box',
    (await inPage(`document.activeElement?.closest('#field-exclusions') !== null`)) === true,
    'the focus was dropped on the body');
  check('a blank exclusion says what is missing rather than storing silently',
    (await inPage(`(document.querySelector('#field-exclusions .problem')?.textContent ?? '').length > 0`)) === true,
    'no problem shown for a blank pattern');

  await type('field-exclusions', 'Pattern', 'notes');
  check('the exclusion is stored as typed',
    JSON.stringify((await stored()).exclusions.fields) === '[{"mode":"contains","pattern":"notes"}]',
    `stored ${JSON.stringify((await stored()).exclusions.fields)}`);

  const excluded = await fillAndRead(['password', 'notes']);
  check('an excluded field is left exactly as it was',
    excluded.notes === '', `notes=${JSON.stringify(excluded.notes)} — the exclusion did not reach the fill`);
  check('and the rest of the form is still filled',
    excluded.password.length > 0, 'nothing was filled at all, so the check above proves nothing');

  // ── UC-023: the context menu, observed on the browser's own menu ───────────
  await openOptions();
  // `update` rather than `remove`: it answers the same question — does this
  // entry exist? — without changing the answer for the next check.
  const menuPresent = async () =>
    (await inWorker(
      `chrome.contextMenus.update('all-inputs', { title: 'Fill all inputs on the page' })
         .then(() => 'yes').catch(() => 'no')`,
    )) === 'yes';

  check('the menu entries exist while the setting is on', await menuPresent(), 'no all-inputs entry');

  await toggle('triggers', 'Show the right-click menu entries', false);
  check('turning the setting off is stored',
    (await stored()).triggers.contextMenu === false, 'the setting did not store');
  check('and the entries are gone from the browser, with no reload',
    (await menuPresent()) === false, 'the all-inputs entry is still on the menu (BR-023-4)');

  await toggle('triggers', 'Show the right-click menu entries', true);
  check('turning it back on restores them',
    await menuPresent(), 'the entries did not come back');

  check('the toolbar button carries no control to turn it off',
    (await inPage(`document.querySelectorAll('#triggers input[type=checkbox]').length`)) === 1,
    'more than one trigger is configurable (BR-023-2)');

  check('the keyboard route is an address, not a control that claims to rebind',
    (await inPage(`(document.querySelector('#triggers')?.textContent ?? '')
       .includes('chrome://extensions/shortcuts')`)) === true,
    'the shortcuts address is not shown (BR-023-1)');

  // ── UC-021: a domain exclusion, observed on a refused fill ─────────────────
  // Last, because it makes the fixture unfillable and everything above needs it.
  await inPage(`document.querySelector('#domain-exclusions button.primary').click()`);
  await sleep(300);
  await type('domain-exclusions', 'Address pattern', '127.0.0.1/*');
  check('the site exclusion is stored as typed',
    JSON.stringify((await stored()).exclusions.domains) === '["127.0.0.1/*"]',
    `stored ${JSON.stringify((await stored()).exclusions.domains)}`);

  const refused = await fillAndRead(['password']);
  check('an excluded site is not filled at all',
    refused.password === '', `password=${JSON.stringify(refused.password)} — the fill was not refused`);

  // The mark is a colour and two letters; the sentence behind it is what makes
  // the refusal actionable, and it is the half UC-008 A4 is actually about.
  check('and the toolbar marks the tab rather than the fill failing silently',
    refused.badge.text === 'off',
    `badge text=${JSON.stringify(refused.badge.text)} (UC-008 A4, FR-038)`);

  /**
   * Which refusal this was, and why the assertion is the weaker one.
   *
   * `activeTab` follows a real user gesture and cannot be synthesised, so a
   * dispatched toolbar click grants no access to the tab's address: the
   * background reads `undefined` and refuses under UC-008 A1 — could not
   * establish where it was being asked to act — rather than by matching the
   * pattern just typed. The refusal is real and so is the mark; what is not
   * covered end-to-end is the *pattern* path, which is the gap `requirements.md`
   * already records against FR-037 and the reason a port defect there survived
   * to a review rather than to a red build.
   *
   * Asserted as "refused, and says which of the two reasons" rather than
   * silently accepting either. A refusal whose tooltip named neither would be a
   * real defect and this is what would catch it.
   */
  check('and the tooltip says why, in words',
    refused.badge.title.includes('127.0.0.1/*') || refused.badge.title.includes('could not be read'),
    `tooltip=${JSON.stringify(refused.badge.title)} — a refusal with no stated reason`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-018..UC-023 — the settings screens, and what they change about a fill\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ settings end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ every Phase 4 setting is reachable, and changes what a fill does\n');
