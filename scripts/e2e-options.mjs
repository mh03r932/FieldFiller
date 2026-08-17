#!/usr/bin/env node
/**
 * UC-009 to UC-013: a rule authored through the options page, end to end.
 *
 * `tests/editing.test.ts` decides whether the rule-list functions are *correct*.
 * This decides whether a person can *reach* them: the assertions here are driven
 * by clicking Add, typing into fields and pressing the move buttons, so what is
 * under test is the wiring between the page and those functions rather than the
 * functions themselves. It has already earned that: it caught handlers that
 * closed over stale state, so editing two fields in a row discarded the first,
 * and a generator-type change that never re-rendered its own fields.
 *
 * The last third is the part that makes the rest matter. Having written a rule
 * through the UI, it navigates to the reference fixture and fills it, so the
 * claim being checked is not "the editor stored something" but "the rule the
 * user wrote is what the page receives" — through storage, the tolerant parser,
 * the compiled rule list and the fill.
 *
 * Usage: pnpm run build && pnpm run options:chrome
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
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-options-'));
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

  /**
   * How this harness picks the tab: the active one, or the only one.
   *
   * Shared by the readiness ping and the trigger, so the tab waited for is the
   * tab filled.
   */
  const TAB = 'tabs.find((candidate) => candidate.active) ?? tabs[0]';

  // No `exceptionDetails` check of its own any more: `send` rejects on one,
  // naming the command, for every session and every harness. This kept its own
  // because it was written before that existed — and `inWorker` below never had
  // one, which is the asymmetry that argues for the check living in one place.
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

  /** Polls a predicate in the page until it holds, or fails saying which one did not. */
  const waitFor = async (expression, whatFailed) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inPage(expression)) === true) return;
      await sleep(100);
    }
    throw new Error(`${whatFailed} (waited 10 s for \`${expression}\`)`);
  };

  const storedRules = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings?.rules ?? []))`,
    )));

  // ── Open the options page and add a rule the way a person does ──────────────
  await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
  // A condition, not a sleep. `waitForAgent` is the wrong tool here — this is
  // one of the extension's own pages and has no content script to ping — so the
  // condition has to be something the editor itself produces.
  //
  // Specifically *not* `#rules` existing: that div is static markup in
  // `index.html`, so it is there the instant the document parses and the wait
  // returns before the script that fills it has run. Written that way first, and
  // it turned the empty-state assertion below red — the condition was satisfied,
  // the paragraph was not yet rendered, and the failure named the options page
  // rather than the harness. Waiting on the child that the render creates is the
  // condition the sleep was standing in for.
  await waitFor(
    `(document.querySelector('#rules')?.children.length ?? 0) > 0`,
    'the rule editor never rendered into #rules',
  );

  check('the options page renders the rule section',
    (await inPage(`document.querySelector('#rules') !== null`)) === true,
    'no #rules container');

  check('an empty list explains itself rather than looking broken',
    (await inPage(`(document.querySelector('#rules p')?.textContent ?? '').length > 20`)) === true,
    `text=${JSON.stringify(await inPage(`document.querySelector('#rules p')?.textContent ?? ''`))}`);

  // Clicked, not called. What is under test is the wiring.
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);

  check('adding a rule opens it for editing',
    (await inPage(`document.querySelector('#rules .rule-body') !== null`)) === true,
    'no editor appeared');

  check('a rule that is not yet valid is not written',
    (await storedRules()).length === 0,
    `stored ${JSON.stringify(await storedRules())} — an incomplete rule reached storage (BR-009-1)`);

  /** Types into a labelled field the way a user would, and fires what a browser fires. */
  const type = async (labelText, value) => {
    await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      if (field === undefined) throw new Error('no field labelled ' + ${JSON.stringify(labelText)});
      const input = field.querySelector('input, textarea');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
  };

  const choose = async (labelText, value) => {
    await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === ${JSON.stringify(labelText)});
      const select = field.querySelector('select');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  await type('Name', 'Order reference');
  await type('Matches', 'short_code');
  await choose('Generates', 'constant');
  await type('Value', 'FROM-A-RULE');
  await sleep(400);

  const rules = await storedRules();
  check('the completed rule is written without a Save button',
    rules.length === 1 && rules[0]?.generator?.value === 'FROM-A-RULE',
    `stored ${JSON.stringify(rules)}`);
  check('the rule keeps the name it was given, for the report',
    rules[0]?.label === 'Order reference', `label=${JSON.stringify(rules[0]?.label)}`);

  check('the preview shows several samples from the real generator',
    (await inPage(`document.querySelectorAll('#rules .samples li').length`)) > 1,
    `samples=${await inPage(`document.querySelectorAll('#rules .samples li').length`)}`);

  // ── An invalid edit is refused, and the previous version stands ─────────────
  await choose('Generates', 'alphanumeric');
  await type('Template', '{nope}');
  await sleep(300);

  check('an invalid edit shows its problem',
    (await inPage(`document.querySelectorAll('#rules .problem').length`)) > 0,
    'no problem shown');
  check('an invalid edit is not written; the previous rule stands',
    (await storedRules())[0]?.generator?.type === 'alphanumeric' === false ||
      (await storedRules())[0]?.generator?.template !== '{nope}',
    `stored ${JSON.stringify((await storedRules())[0]?.generator)}`);

  await type('Template', 'REF-{digit:3}');
  await sleep(300);
  check('correcting it writes again',
    (await storedRules())[0]?.generator?.template === 'REF-{digit:3}',
    `stored ${JSON.stringify((await storedRules())[0]?.generator)}`);

  // ── Two fields of one generator, in sequence ────────────────────────────────
  // Every generator exercised above carries exactly one field, and that is why
  // this harness passed while `min` then `max` silently discarded `min`: each
  // field handler spread from the generator captured when the fields were built
  // rather than from the live rule, so the second edit was computed against the
  // state before the first. Nothing visible said so — a non-structural edit does
  // not re-render, so the inputs kept showing both values while storage held one.
  //
  // A multi-field generator is therefore not an extra case here, it is the case
  // that makes the others' passing mean something.
  await choose('Generates', 'number');
  await type('Lowest', '10');
  await sleep(200);
  await type('Highest', '99');
  await sleep(300);

  const both = (await storedRules())[0]?.generator;
  check('editing two fields of one generator keeps both',
    both?.min === 10 && both?.max === 99,
    `stored ${JSON.stringify(both)} — expected min 10 and max 99, both of them`);

  // Compared against what storage *holds*, never against the literals typed
  // above. That distinction is the whole check: with the defect present the
  // fields still show 10 and 99 — a non-structural edit does not re-render them
  // — so asserting they show what was typed passes while the two sides
  // disagree. Written that way first, and it did pass against the bug.
  const shown = await inPage(`(() => {
    const value = (labelText) => [...document.querySelectorAll('#rules .rule-body label.field')]
      .find((label) => label.querySelector('span')?.textContent === labelText)
      ?.querySelector('input')?.value ?? '';
    return JSON.stringify({ min: value('Lowest'), max: value('Highest') });
  })()`);
  const held = JSON.stringify({ min: String(both?.min ?? ''), max: String(both?.max ?? '') });
  check('and the fields agree with storage, rather than only with what was typed',
    shown === held,
    `fields ${shown} vs stored ${held} — the page and storage disagree until reload`);

  // Back to a shape the ordering checks below expect.
  await choose('Generates', 'alphanumeric');
  await type('Template', 'REF-{digit:3}');
  await sleep(300);

  // ── Ordering is precedence, and the controls say so ─────────────────────────
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);
  await type('Name', 'Second');
  await type('Matches', 'short_code');
  await choose('Generates', 'constant');
  await type('Value', 'SECOND-RULE');
  await sleep(400);

  check('the new rule is appended, not inserted',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Order reference|Second',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);

  check('the first rule cannot be moved up',
    (await inPage(`document.querySelector('#rules .rule .rule-order button').disabled`)) === true,
    'the up control was available on the first rule');

  await inPage(`document.querySelectorAll('#rules .rule')[1].querySelectorAll('.rule-order button')[0].click()`);
  await sleep(400);
  check('moving a rule up reorders storage',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Second|Order reference',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);
  check('the move is announced for a reader who cannot see the list',
    (await inPage(`document.querySelector('#announcements').textContent`)).includes('Second'),
    `announcement=${JSON.stringify(await inPage(`document.querySelector('#announcements').textContent`))}`);

  // ── The point of all of it: the rule changes what a fill writes ─────────────
  await cdp.send('Page.navigate', { url: pageUrl }, page);
  // Now it *is* a content-script page, so the agent's own ping is the condition.
  await waitForAgent(cdp, workerSession, TAB);
  const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
    const tab = ${TAB};
    if (tab === undefined) return 'no tab';
    if (typeof chrome.action.onClicked.dispatch !== 'function') {
      return 'chrome.action.onClicked.dispatch is not available in this Chrome';
    }
    chrome.action.onClicked.dispatch(tab);
    return 'ok';
  }).catch((error) => 'threw: ' + error.message)`);
  if (fired !== 'ok') throw new Error(`the toolbar trigger did not fire — ${String(fired)}`);

  let landed = '';
  for (let elapsed = 0; elapsed < 6000 && landed === ''; elapsed += 200) {
    await sleep(200);
    landed = String(await inPage(`document.querySelector('[name=short_code]')?.value ?? ''`));
  }

  // "Second" now precedes "Order reference" and both match `short_code`, so
  // first-match-wins decides — which is the whole reason ordering is a feature.
  check('the rule the user wrote is what the page receives',
    landed.startsWith('SECON'),
    `short_code=${JSON.stringify(landed)} — expected the first matching rule's value`);

  // And the page still wins over the rule. `short_code` carries maxlength="5",
  // so `SECOND-RULE` arrives cut to five characters: a rule supplies policy, the
  // field supplies the ceiling, and the ceiling holds (DD-005, FR-072, ND-11).
  // Asserted rather than worked around — the first run of this harness expected
  // the whole string and read the truncation as a failure.
  check('the field’s own constraints still bound what a rule produces',
    landed === 'SECON',
    `short_code=${JSON.stringify(landed)} — expected it cut to the field's maxlength of 5`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-009..UC-013 — a rule authored through the options page\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ options page end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a rule written in the options page reaches the page being filled\n');
