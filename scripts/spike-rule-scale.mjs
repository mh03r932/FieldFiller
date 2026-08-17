#!/usr/bin/env node
/**
 * The measurement NFR-024 names: 500 rules, no interaction over 100 ms.
 *
 * Recorded rather than asserted, and in a spike rather than in the harness,
 * because a threshold this close to the machine belongs where a number can be
 * read and argued with. `e2e-options.mjs` decides whether the editor is
 * *correct*; this decides whether it is usable at the scale the requirement
 * names, and a CI runner under load is not evidence about that either way.
 *
 * What is measured, in the real browser rather than in happy-dom — the DOM cost
 * is the whole question, and a DOM implementation without layout answers a
 * different one:
 *
 *   · **first render** of a 500-rule list, which is what a user with a large
 *     configuration waits for when the page opens;
 *   · **expanding a rule**, the interaction that rebuilds the list *and* builds
 *     an editor body with a live preview inside it;
 *   · **a move**, which rebuilds the whole list and returns focus — the
 *     interaction UC-012 puts under the keyboard, so a slow one is felt as lag
 *     between keypress and announcement;
 *   · **an ordinary keystroke** in an open rule, which deliberately does *not*
 *     rebuild the list, and is here to show that it does not.
 *
 * The list is rebuilt in full on every structural change and every row runs
 * `validateRule`, so the cost that matters is O(rules) per interaction and the
 * question is only what the constant is.
 *
 * Usage: pnpm run build && node scripts/spike-rule-scale.mjs
 *   CHROME_PATH=…  override the browser binary
 *   RULES=…        rules to seed (default 500, the number NFR-024 names)
 *   RUNS=…         samples per interaction (default 9)
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachToWorker,
  closeChromium,
  derivedExtensionId,
  launchChromium,
  sleep,
} from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const RULES = Number(process.env['RULES'] ?? 500);
const RUNS = Number(process.env['RUNS'] ?? 9);

/** The bound NFR-024 states, in milliseconds. */
const BUDGET = 100;

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-scale-'));
let chrome;
let cdp;

/**
 * A rule list that cannot flatter the result.
 *
 * A third of the matchers are regexes, which is the branch that compiles a
 * pattern and runs the backtracking analyser; a quarter of the generators are
 * regex generators, which additionally parse the pattern into a node tree. A
 * list of `contains` matchers and constant generators would measure the DOM
 * alone and report a number no configuration would ever reproduce.
 */
function seedRules(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `scale-${index}`,
    label: `Rule number ${index}`,
    enabled: true,
    match:
      index % 3 === 0
        ? { mode: 'regex', pattern: `^(field|input)_${index}[a-z]*$` }
        : { mode: 'contains', pattern: `field_${index}` },
    generator:
      index % 4 === 0
        ? { type: 'regex', pattern: '[A-Z]{3}-\\d{4}' }
        : index % 4 === 1
          ? { type: 'alphanumeric', template: 'INV-{digit:4}' }
          : { type: 'text', minWords: 3, maxWords: 8 },
    fromPersona: true,
  }));
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function report(name, samples) {
  const worst = Math.max(...samples);
  const ok = worst <= BUDGET;
  const mark = ok ? '✔' : '✖';
  console.log(
    `  ${mark} ${name.padEnd(34)} median ${median(samples).toFixed(1).padStart(6)} ms` +
      `   worst ${worst.toFixed(1).padStart(6)} ms`,
  );
  return ok;
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

  // Seeded through storage rather than through the editor: authoring 500 rules
  // by clicking would measure the harness. The parser runs on the way back out,
  // so what the page renders is a state it could really hold.
  await cdp.send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.local.set({ settings: ${JSON.stringify({
        version: 1,
        locale: 'auto',
        rules: seedRules(RULES),
        profiles: [],
        exclusions: { fields: [], domains: [] },
        behaviour: { dispatchEvents: true, skipHidden: true, skipPreFilled: false, maxLengths: {} },
        passwords: { length: 16, upper: true, lower: true, digits: true, symbols: true },
        sources: { name: true, id: true, className: false, label: true, placeholder: true, ariaLabel: true },
      })} })`,
      awaitPromise: true,
    },
    workerSession,
  );

  console.log(`\n  NFR-024 — ${RULES} rules in the options page, ${RUNS} samples per interaction\n`);

  // ── First render ───────────────────────────────────────────────────────────
  // Measured as a whole navigation-to-list-present interval, because that is
  // what the user waits through: the parse, the settings read and the build.
  const firstRenders = [];
  for (let run = 0; run < RUNS; run++) {
    await cdp.send('Page.navigate', { url: 'about:blank' }, page);
    await sleep(120);
    const started = Date.now();
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    for (;;) {
      const rendered = await inPage(`document.querySelectorAll('#rules li.rule').length === ${RULES}`);
      if (rendered === true) break;
      await sleep(5);
    }
    firstRenders.push(Date.now() - started);
  }

  // ── Interactions, timed in the page around the click ───────────────────────
  // `performance.now()` is coarsened to 100 microseconds in a page context, but
  // every interaction here is milliseconds, so a single sample is well clear of
  // the clock's resolution and no batching is needed.
  const interaction = async (setup, action) => {
    const samples = [];
    for (let run = 0; run < RUNS; run++) {
      await inPage(setup);
      await sleep(60);
      samples.push(
        await inPage(`(() => {
          const started = performance.now();
          ${action}
          return performance.now() - started;
        })()`),
      );
      await sleep(60);
    }
    return samples;
  };

  // Expanding a rule in the middle of the list: rebuilds all 500 rows and builds
  // an editor body, whose preview runs the real generator four times.
  const expands = await interaction(
    `(() => {
      const open = document.querySelector('#rules .rule-name[aria-expanded="true"]');
      if (open) open.click();
      return true;
    })()`,
    `document.querySelectorAll('#rules .rule-name')[${Math.floor(RULES / 2)}].click();`,
  );

  // A move: the same full rebuild, plus the focus return UC-012 requires.
  const moves = await interaction(
    `true`,
    `document.querySelectorAll('#rules .rule-order button[data-direction="down"]')[${Math.floor(RULES / 2)}].click();`,
  );

  // A keystroke in an open rule, which replaces only the preview and the
  // problems. Here to show the list length does not reach it.
  const keystrokes = await interaction(
    `(() => {
      const open = document.querySelector('#rules .rule-name[aria-expanded="true"]');
      if (!open) document.querySelectorAll('#rules .rule-name')[${Math.floor(RULES / 2)}].click();
      return true;
    })()`,
    `(() => {
      const input = document.querySelector('#rules .rule-body input[type="text"]');
      input.value = 'renamed ' + Math.random();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })();`,
  );

  const results = [
    report('first render (navigate → list)', firstRenders),
    report('expand a rule', expands),
    report('move a rule down', moves),
    report('keystroke in an open rule', keystrokes),
  ];

  console.log(`\n  Budget: ${BUDGET} ms per interaction (NFR-024).\n`);

  if (results.includes(false)) {
    console.error('✖ an interaction exceeded the NFR-024 budget\n');
    process.exitCode = 1;
  } else {
    console.log(`✔ ${RULES} rules stay inside the budget\n`);
  }
} catch (error) {
  console.error(`\n✖ rule-scale spike failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}
