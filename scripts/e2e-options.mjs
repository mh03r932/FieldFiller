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

  // The write this page just made comes back through its own `storage.onChanged`
  // listener, and it does not match what the page holds in memory: the new rule
  // has an empty pattern, so the parser drops it on the way in. Compared naively
  // that reads as somebody else's write — on the primary happy path, telling a
  // screen-reader user their page is stale and to reload, which would discard the
  // rule they are being invited to type. Nobody sighted would ever have seen it.
  const announced = async () =>
    String(await inPage(`document.querySelector('#announcements')?.textContent ?? ''`));

  check('adding a rule does not claim the settings changed somewhere else',
    !(await announced()).includes('changed somewhere else'),
    `announced "${await announced()}"`);

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

  // ── Structural edits to a rule that is not valid yet ────────────────────────
  // A new rule has no pattern, so it is invalid from the moment it appears —
  // which makes "choose the generator first" an ordinary opening move rather
  // than an edge case. A structural edit rebuilds the list from the last
  // *committed* state, and an invalid rule was never committed, so the choice
  // was drawn back to what it had been. The harness only ever changed the
  // generator on an already-valid rule, which is why it never saw this.
  const selectedGenerator = async () =>
    String(await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === 'Generates');
      return field?.querySelector('select')?.value ?? 'none';
    })()`));

  await choose('Generates', 'date');
  check('a generator chosen before the pattern is typed stays chosen',
    (await selectedGenerator()) === 'date',
    `the select shows ${await selectedGenerator()} — a structural edit was drawn back`);
  check('and the fields belonging to it are the ones on screen',
    (await inPage(`[...document.querySelectorAll('#rules .rule-body label.field span')]
       .some((span) => span.textContent === 'Format')`)) === true,
    'the new type’s own fields never appeared');

  // The same question for the other structural control, on the same not-yet-
  // valid rule: unticking "whatever is enabled globally" has to reveal the six.
  await inPage(`(() => {
    const box = document.querySelector('#rules .rule-body fieldset.sources input.sources-all');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  check('per-rule scoping is reachable before the rule is valid',
    (await inPage(`document.querySelectorAll('#rules .rule-body fieldset.sources input').length`)) === 7,
    `${await inPage(`document.querySelectorAll('#rules .rule-body fieldset.sources input').length`)} checkboxes`);

  // And text already typed into the open editor survives a structural edit made
  // while the rule is invalid — the case that loses work rather than merely
  // refusing it.
  await type('Name', 'Typed before valid');
  await choose('Generates', 'list');
  check('text typed into an invalid rule survives a structural edit',
    (await inPage(`(() => {
      const field = [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === 'Name');
      return field?.querySelector('input')?.value ?? '';
    })()`)) === 'Typed before valid',
    'the name was redrawn from the last committed version');

  // Back to the shape the rest of the file expects.
  await inPage(`(() => {
    const box = document.querySelector('#rules .rule-body fieldset.sources input.sources-all');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);

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

  // ── Several fields of one generator, edited in sequence ─────────────────────
  // Every generator exercised above carries exactly one field, and that is why
  // this harness passed while `min` then `max` silently discarded `min`: each
  // field handler spread from the generator captured when the fields were built
  // rather than from the live rule, so the second edit was computed against the
  // state before the first. Nothing visible said so — a non-structural edit does
  // not re-render, so the inputs kept showing both values while storage held one.
  //
  // All three multi-field generators, because one of them passing proves nothing
  // about the others: the defect was per-handler, and these are three separate
  // sets of handlers. `date` carries three fields rather than two, which is the
  // case where a third edit could discard the first two rather than only one.
  //
  // Each step leaves the rule valid on its own — an invalid intermediate would
  // not be written at all, and the check would then fail for a reason that has
  // nothing to do with what it is asking.
  const MULTI_FIELD = [
    { type: 'number', edits: [['Lowest', '10', 'min', 10], ['Highest', '99', 'max', 99]] },
    {
      type: 'date',
      edits: [
        ['Format', 'DD.MM.YYYY', 'format', 'DD.MM.YYYY'],
        ['Earliest', '2000-01-01', 'from', '2000-01-01'],
        ['Latest', '2010-12-31', 'to', '2010-12-31'],
      ],
    },
    { type: 'text', edits: [['Fewest words', '4', 'minWords', 4], ['Most words', '6', 'maxWords', 6]] },
  ];

  for (const { type: generatorType, edits } of MULTI_FIELD) {
    await choose('Generates', generatorType);
    for (const [label, typed] of edits) {
      await type(label, typed);
      await sleep(200);
    }
    await sleep(200);

    const stored = (await storedRules())[0]?.generator;
    const wanted = Object.fromEntries(edits.map(([, , key, value]) => [key, value]));
    check(`editing every field of the ${generatorType} generator keeps all of them`,
      edits.every(([, , key, value]) => stored?.[key] === value),
      `stored ${JSON.stringify(stored)} — expected ${JSON.stringify(wanted)}`);

    // Compared against what storage *holds*, never against the literals typed
    // above. That distinction is the whole check: with the defect present the
    // fields still show every value typed — a non-structural edit does not
    // re-render them — so asserting they show what was typed passes while the
    // two sides disagree. Written that way first, and it did pass against the
    // bug.
    const labels = JSON.stringify(edits.map(([label]) => label));
    const shown = await inPage(`(() => {
      const value = (labelText) => [...document.querySelectorAll('#rules .rule-body label.field')]
        .find((label) => label.querySelector('span')?.textContent === labelText)
        ?.querySelector('input')?.value ?? '';
      return JSON.stringify(${labels}.map(value));
    })()`);
    const held = JSON.stringify(edits.map(([, , key]) => String(stored?.[key] ?? '')));
    check(`and the ${generatorType} fields agree with storage, not merely with what was typed`,
      shown === held,
      `fields ${shown} vs stored ${held} — the page and storage disagree until reload`);
  }

  // ── Per-rule source scoping, which changes the field set (FR-067) ───────────
  // The same defect class as the generator type, in the other control that
  // decides which fields exist. Clearing "Whatever is enabled globally" gives the
  // rule its own list of sources, which is six checkboxes that exist only when
  // that list does — and until 2026-08-17 the edit was not structural, so the
  // list was written to storage and nothing appeared. Per-rule scoping was
  // unreachable from the editor, with no error and no clue.
  //
  // This harness never touched the control, which is why CI was green.
  const sourceBoxes = async () =>
    inPage(`document.querySelectorAll('#rules .rule-body fieldset.sources input[type=checkbox]').length`);

  const allOn = await sourceBoxes();
  check('with global scoping on, only the one checkbox is offered',
    allOn === 1, `${allOn} checkboxes — expected just "Whatever is enabled globally"`);

  await inPage(`(() => {
    const box = document.querySelector('#rules .rule-body fieldset.sources input.sources-all');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);

  const revealed = await sourceBoxes();
  check('clearing it reveals a checkbox per source, so the scoping can be reached',
    revealed === 7, `${revealed} checkboxes — expected the "all" box plus one per source`);
  check('and the rule now carries its own source list',
    Array.isArray((await storedRules())[0]?.sources) &&
      (await storedRules())[0]?.sources?.length === 6,
    `sources=${JSON.stringify((await storedRules())[0]?.sources)}`);

  // The six are labelled for a reader, not with the identifiers the code uses
  // (NFR-018). They were passed straight in as labels until 2026-08-17, so this
  // screen said "className" and "ariaLabel" to somebody who never wrote either.
  const sourceLabels = await inPage(`JSON.stringify(
    [...document.querySelectorAll('#rules .rule-body fieldset.sources label')]
      .slice(1)
      .map((label) => label.textContent.trim()),
  )`);
  const labels = JSON.parse(sourceLabels);
  check('the sources are labelled in words, not in identifiers',
    labels.length === 6 && !labels.some((label) => /^[a-z]+[A-Z]/.test(label)),
    `labels=${sourceLabels}`);

  // Narrowing it is the point of the feature, and the checkboxes have to be live
  // for that — a revealed control that does nothing is the same defect wearing a
  // different face.
  const untick = async (label) => {
    await inPage(`(() => {
      const boxes = [...document.querySelectorAll('#rules .rule-body fieldset.sources label')];
      const box = boxes.find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
      const input = box.querySelector('input');
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
  };

  await untick('CSS classes');
  check('unchecking one source narrows the stored list',
    !((await storedRules())[0]?.sources ?? []).includes('className') &&
      ((await storedRules())[0]?.sources ?? []).length === 5,
    `sources=${JSON.stringify((await storedRules())[0]?.sources)}`);

  // Unticking the *last* one is the case that had no answer: an empty list is
  // well-shaped, survives the parser, and matches nothing at all, so the rule
  // was written to storage looking finished and was dead. The preview cannot
  // reveal it — it draws from the generator, which is fine — so validation has
  // to, and the write has to be refused like any other invalid edit (FR-070).
  for (const label of ['Name attribute', 'ID attribute', 'Label text', 'Placeholder text', 'Accessible name']) {
    await untick(label);
  }

  const noSourceProblem = await inPage(
    `document.querySelector('#rules .rule-body .problems')?.textContent?.trim() ?? ''`,
  );
  check('unticking every source states that the rule could never fire',
    noSourceProblem.includes('never fire'), `problems="${noSourceProblem}"`);
  // The last source standing, not the five we began with: every untick down to
  // one is a valid narrowing and is written as it happens, which is the whole
  // no-Save-button contract. Only the step to nothing is refused, so storage
  // stops one short of the edit on screen.
  check('and the rule scoped to nothing is not written',
    ((await storedRules())[0]?.sources ?? []).length === 1,
    `sources=${JSON.stringify((await storedRules())[0]?.sources)}`);

  // And back: re-checking "all" has to remove the six, not leave them on screen
  // editing a list the rule no longer has.
  await inPage(`(() => {
    const box = document.querySelector('#rules .rule-body fieldset.sources input.sources-all');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  check('restoring global scoping removes the per-source boxes again',
    (await sourceBoxes()) === 1, `${await sourceBoxes()} checkboxes remain`);
  check('and the rule stops carrying its own list',
    (await storedRules())[0]?.sources === undefined,
    `sources=${JSON.stringify((await storedRules())[0]?.sources)}`);

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

  // ── Focus after a move lands on the button that was pressed (UC-012 step 3) ─
  // Needs a third rule, because up and down only disagree in the middle of a
  // list: for any rule but the first, `button:not(:disabled)` is the up arrow,
  // so a rule moved *down* into a middle position is the one case where
  // "whichever is enabled" and "the one just pressed" differ. With two rules
  // every move ends at an end, the pressed button is disabled, and the fallback
  // hides the defect.
  //
  // The spare rule matches nothing the fill below reads, and the moves undo
  // themselves, so the order the last assertions depend on is restored.
  await inPage(`document.querySelector('#rules button.primary').click()`);
  await sleep(300);
  await type('Name', 'Spare');
  await type('Matches', 'zzz_unused');
  await choose('Generates', 'constant');
  await type('Value', 'SPARE');
  await sleep(400);

  /** Clicks a move button on a named rule, and reports where the focus landed. */
  const moveAndFocus = async (label, direction) => {
    await inPage(`(() => {
      const row = [...document.querySelectorAll('#rules .rule')]
        .find((item) => item.querySelector('.rule-name')?.textContent?.startsWith(${JSON.stringify(label)}));
      if (row === undefined) throw new Error('no rule named ' + ${JSON.stringify(label)});
      row.querySelector('.rule-order button[data-direction=' + ${JSON.stringify(direction)} + ']').click();
      return true;
    })()`);
    await sleep(300);
    return inPage(`document.activeElement?.dataset?.direction ?? 'nowhere'`);
  };

  check('after moving a rule down, the focus is on the button that moved it',
    (await moveAndFocus('Second', 'down')) === 'down',
    'focus went elsewhere — a second press would move the rule straight back');

  // Back to the top, where the button just pressed becomes disabled. Focus has
  // to go to the other one rather than to the body: written expecting 'up'
  // first, and this is the case that corrected it — the fallback is the right
  // answer here, not a second-best.
  check('and moving it to an end falls back rather than dropping the focus',
    (await moveAndFocus('Second', 'up')) === 'down',
    'focus was lost when the button that moved the rule became disabled');

  check('the moves left the order they started in',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Second|Order reference|Spare',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);

  // ── Focus survives every rebuild, not only the one that was fixed ───────────
  // `renderRules` replaces the container's children, so whatever was clicked no
  // longer exists and the focus falls to `<body>` unless something says where it
  // belongs. The move buttons were given that treatment; expand, delete and undo
  // were not, and each dropped a keyboard user back at the top of the page
  // (WCAG 2.4.3, NFR-019).
  const focused = async () =>
    String(await inPage(`(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return 'body';
      const row = active.closest('[data-rule]');
      const label = row?.querySelector('.rule-name')?.textContent?.trim() ?? '';
      return [active.className.split(' ')[0] || active.tagName.toLowerCase(), label].join(':');
    })()`));

  const clickDisclosure = async (label) => {
    await inPage(`(() => {
      const button = [...document.querySelectorAll('#rules .rule-name')]
        .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(label)}));
      button.click();
      return true;
    })()`);
    await sleep(250);
  };

  await clickDisclosure('Order reference');
  check('expanding a rule keeps the focus on the rule it expanded',
    (await focused()) === 'rule-name:Order reference', `focus=${await focused()}`);

  await clickDisclosure('Order reference');
  check('and collapsing it does the same',
    (await focused()) === 'rule-name:Order reference', `focus=${await focused()}`);

  // Delete offers an undo, and the offer renders after every remaining rule. A
  // keyboard user with the focus dropped would have to tab the length of the
  // list to reach the reversal BR-011-1 is built on.
  await inPage(`(() => {
    const row = [...document.querySelectorAll('#rules li.rule')]
      .find((candidate) => candidate.querySelector('.rule-name').textContent.trim().startsWith('Spare'));
    row.querySelector('.rule-delete').click();
    return true;
  })()`);
  await sleep(250);

  // Identity, not a name: the undo button carries no class of its own, so
  // describing it by appearance is how the first version of this check passed
  // for the wrong reason.
  check('deleting a rule moves the focus to the undo it just offered',
    (await inPage(
      `document.activeElement === document.querySelector('#rules .undo button')`,
    )) === true,
    `focus=${await focused()}`);

  await inPage(`document.querySelector('#rules .undo button').click()`);
  await sleep(250);

  check('undoing puts the focus on the rule that came back',
    (await focused()) === 'rule-name:Spare', `focus=${await focused()}`);
  check('and the rule came back where it was',
    (await storedRules()).map((rule) => rule.label).join('|') === 'Second|Order reference|Spare',
    `order=${JSON.stringify((await storedRules()).map((rule) => rule.label))}`);

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

  // ── A second writer, while a rule is open here (UC-024, BR-024-3) ───────────
  // The page holds the whole settings state and writes all of it on every
  // change, so a stale snapshot is not a display problem — it is the next write
  // reverting somebody else's work. While a rule is open the list on screen is
  // deliberately not replaced (that would take the caret with it), so the page
  // used to keep its pre-change snapshot and the advice it announced — finish
  // the rule, then reload — walked the user into exactly the loss it warned
  // about: the next valid keystroke wrote the old state back.
  //
  // Last in the file because it navigates back to the options page, so nothing
  // after it depends on the state this leaves behind.
  //
  // The values land before the fill *operation* closes, and the report is built
  // when it does — so this waits before asking, rather than reading an honest
  // "no report yet" as the defect below.
  await sleep(4000);
  await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
  await waitFor(
    `(document.querySelector('#rules')?.children.length ?? 0) > 0`,
    'the rule editor never rendered after navigating back',
  );

  // DD-006's third surface, and until 2026-08-17 it never worked: the background
  // refused the report request from any sender with a `tab`, meaning to exclude
  // content scripts — but an options page *is* a tab, which is how the browser
  // opens one. The page fell back to "no report is available", and that text
  // blames the background being evicted between uses, which is plausible enough
  // that the failure read as the design working.
  const reportRows = Number(await inPage(`document.querySelectorAll('#report tbody tr').length`));
  check('the fill that just ran is reported back on the options page',
    reportRows > 0,
    `#report has no rows — text was ${JSON.stringify(
      String(await inPage(`document.querySelector('#report')?.textContent?.slice(0, 90) ?? ''`)),
    )}`);

  await clickDisclosure('Second');
  check('a rule is open for the concurrent-writer check',
    (await inPage(`document.querySelector('#rules .rule-body') !== null`)) === true,
    'no editor open');

  // Somebody else's write: the stored list plus a rule this page has never seen.
  await inWorker(`chrome.storage.local.get('settings').then((state) => {
    const next = state.settings;
    next.rules = [...next.rules, {
      id: 'from-another-tab',
      label: 'From another tab',
      enabled: true,
      match: { mode: 'contains', pattern: 'nothing_matches_this' },
      generator: { type: 'constant', value: 'ELSEWHERE' },
      fromPersona: true,
    }];
    return chrome.storage.local.set({ settings: next });
  })`);
  await sleep(400);

  check('a foreign write while editing is announced rather than applied to the open rule',
    (await announced()).includes('changed somewhere else'),
    `announced "${await announced()}"`);
  check('and the rule being edited is still on screen',
    (await inPage(`document.querySelector('#rules .rule-body') !== null`)) === true,
    'the open editor was replaced, which would have discarded the draft');

  // The keystroke the announcement invites. It commits the whole state, so this
  // is the moment the other tab's rule either survives or vanishes.
  await type('Name', 'Second');
  await sleep(300);

  const afterEdit = (await storedRules()).map((rule) => rule.label);
  check('a later edit here does not revert the other writer',
    afterEdit.includes('From another tab'),
    `rules=${JSON.stringify(afterEdit)} — the foreign rule was written over`);
  check('and the rule being edited is still the one the user typed',
    afterEdit.includes('Second'), `rules=${JSON.stringify(afterEdit)}`);

  // Closing the rule is what the list on screen was waiting for.
  await clickDisclosure('Second');
  check('closing the rule brings the list up to date',
    (await inPage(
      `[...document.querySelectorAll('#rules .rule-name')].some((button) =>
         button.textContent.trim().startsWith('From another tab'))`,
    )) === true,
    'the foreign rule never appeared after the editor closed');
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
