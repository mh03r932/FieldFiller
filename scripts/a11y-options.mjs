#!/usr/bin/env node
/**
 * NFR-019 — the WCAG 2.1 AA audit of the options page.
 *
 * The requirement says the options UI *must meet* WCAG 2.1 AA. Until this
 * existed the status could only say that the parts someone had thought about
 * looked right, which is not the same claim and was recorded as not the same
 * claim. This measures it.
 *
 * Automated checking covers roughly a third to a half of the AA criteria — the
 * machine-decidable ones: contrast, names, roles, labels, structure. The rest
 * are judgement (is this the right heading level? does this alternative text say
 * the same thing?) and are listed at the end of this file as a manual checklist
 * with the reasoning recorded, because a criterion nobody looked at and a
 * criterion that passed look identical in a report that omits it.
 *
 * What runs here:
 *
 *   · **axe-core**, restricted to the WCAG 2.1 A and AA tags. Best-practice
 *     rules are excluded deliberately: they are advice, and mixing them into a
 *     conformance number makes the number mean nothing.
 *   · **Both colour schemes.** The stylesheet declares light and dark together
 *     and claims both clear 4.5:1. A dark palette is where that claim usually
 *     breaks, and `prefers-color-scheme` is emulated so both are really rendered.
 *   · **Both page states.** The editor with a rule open, an invalid rule, the
 *     per-source checkboxes revealed and an undo offer showing; and the page
 *     after a real fill, so the report table is present. The table carries the
 *     outcome colours, which is the one place colour could carry meaning alone.
 *   · **Reflow (1.4.10)** at 320 CSS pixels, and **resize (1.4.4)** at 200% text,
 *     neither of which axe can see.
 *   · **The declared palette**, measured pair by pair, because "at or above
 *     4.5:1" was a comment in the stylesheet and not a number anyone had taken.
 *
 * Usage: pnpm run build && pnpm run a11y
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core'), 'utf8');

/** The conformance target, and nothing else. Best-practice rules are advice. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-a11y-'));
let chrome;
let cdp;

const html = readFileSync(FIXTURE, 'utf8');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const findings = [];
const notes = [];

/** A settings state that puts every control on the page at once. */
const SEED = {
  version: 1,
  locale: 'auto',
  rules: [
    {
      id: 'a11y-1', label: 'Invoice reference', enabled: true,
      match: { mode: 'contains', pattern: 'short_code' },
      generator: { type: 'alphanumeric', template: 'INV-{digit:4}' },
      fromPersona: true,
    },
    {
      // Invalid on purpose: renders the `!` flag and the role="alert" problem
      // list, which are the two places the editor speaks in colour and in prose.
      id: 'a11y-2', label: 'Broken on purpose', enabled: true,
      match: { mode: 'regex', pattern: '(a+)+$' },
      generator: { type: 'number', min: 10, max: 1, decimals: 0 },
      fromPersona: true,
    },
    {
      id: 'a11y-3', label: 'Scoped rule', enabled: true,
      match: { mode: 'exact', pattern: 'email' },
      sources: ['name', 'id'],
      generator: { type: 'date', format: 'YYYY-MM-DD', from: '1990-01-01', to: '2035-12-31' },
      fromPersona: true,
    },
    {
      id: 'a11y-4', label: 'Spare for deleting', enabled: false,
      match: { mode: 'contains', pattern: 'nothing' },
      generator: { type: 'list', items: ['one', 'two'] },
      fromPersona: false,
    },
  ],
  // One valid and one inert, so the profile row is audited both with and without
  // its `!` flag and its `role="alert"` problem line (UC-014 A2). Neither is
  // expanded — the audit opens rules, not profiles — so what is covered here is
  // the collapsed row, which is the state the list is in when it is read.
  profiles: [
    {
      id: 'a11y-p1', label: 'Staging', enabled: true,
      urls: ['*.staging.example.com/*'],
      rules: [
        {
          id: 'a11y-p1-r1', label: 'Scoped reference', enabled: true,
          match: { mode: 'contains', pattern: 'short_code' },
          generator: { type: 'constant', value: 'SCOPED' },
          fromPersona: true,
        },
      ],
    },
    { id: 'a11y-p2', label: 'Matches nothing', enabled: true, urls: [], rules: [] },
  ],
  // Populated rather than empty, because an empty list renders one paragraph and
  // the markup worth auditing is the row: a select, a text box, a remove button
  // and a `role="alert"` problem line sharing one grid cell. One of each is
  // deliberately invalid, for the same reason the broken rule above is — the
  // problem line is where this page speaks in colour and in prose (UC-020,
  // UC-021).
  exclusions: {
    fields: [
      { mode: 'contains', pattern: 'captcha' },
      { mode: 'regex', pattern: '(a+)+$' },
    ],
    // Empty, and it has to be. Any non-empty domain list makes the background
    // read the tab's address before every fill — which a synthesised toolbar
    // click cannot grant (`activeTab` follows a real gesture), so every fill in
    // this harness would be refused and the report section below would have
    // nothing to audit. The domain row is built from the same `.exclusion`,
    // `.row`, `.problems` and `.exclusion-delete` markup as the field rows above
    // it, minus the mode select, so what is skipped here is a subset of what is
    // audited. `scripts/e2e-settings.mjs` is where the domain list is driven.
    domains: [],
  },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: false,
    // A cap set, so the optional number box is audited holding a value as well
    // as empty (UC-022).
    maxLengths: { textarea: 120 },
    consentKeywords: ['terms', 'privacy'],
    confirmationKeywords: ['confirm', 'repeat'],
  },
  passwords: { length: 16, upper: true, lower: true, digits: true, symbols: true },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

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

  await inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(SEED)} })`);

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inPage(`(document.querySelector('#rules')?.children.length ?? 0) > 0`)) === true) {
        return;
      }
      await sleep(100);
    }
    throw new Error('the options page never rendered');
  };

  /**
   * Runs axe over whatever is on screen, in one colour scheme.
   *
   * Injected per run rather than once: every navigation discards the page's
   * globals, and a stale `axe` would be a reference into a destroyed context.
   */
  const audit = async (state, scheme) => {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    }, page);
    // A repaint has to happen before contrast is sampled, or axe measures the
    // colours of the scheme that was on screen a moment ago.
    await sleep(250);

    await inPage(AXE);
    const raw = await inPage(`axe.run(document, {
      runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} },
      resultTypes: ['violations'],
    }).then((result) => JSON.stringify({
      violations: result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        tags: violation.tags.filter((tag) => tag.startsWith('wcag')),
        nodes: violation.nodes.slice(0, 4).map((node) => ({
          target: node.target.join(' '),
          summary: node.failureSummary,
        })),
      })),
      counts: { passes: result.passes?.length ?? 0 },
    }))`);

    const { violations } = JSON.parse(String(raw));
    for (const violation of violations) findings.push({ state, scheme, ...violation });
    return violations.length;
  };

  // ── Fill a page first, so the report section has something in it ────────────
  // Before opening the options page, not after: the report is requested once at
  // load, so a fill that happens later renders nothing without a reload — and
  // navigating away mid-fill kills the operation that would have produced it.
  // Doing it in this order means one page carries both sections, which is also
  // how a user meets them.
  await cdp.send('Page.navigate', { url: pageUrl }, page);
  await waitForAgent(cdp, workerSession, `tabs.find((tab) => tab.active) ?? tabs[0]`);
  const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
    const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
    if (tab === undefined) return 'no tab';
    if (typeof chrome.action.onClicked.dispatch !== 'function') return 'no dispatch in this Chrome';
    chrome.action.onClicked.dispatch(tab);
    return 'ok';
  }).catch((error) => 'threw: ' + error.message)`);
  if (fired !== 'ok') throw new Error(`the fill did not fire — ${String(fired)}`);

  let landed = '';
  for (let attempt = 0; attempt < 40 && landed === ''; attempt++) {
    await sleep(150);
    landed = String(await inPage(`document.querySelector('[name=short_code]')?.value ?? ''`));
  }
  // The values land before the operation closes: the report is built when the
  // last frame has reported or the wait for it expires, and only then is there
  // anything for the options page to ask about.
  await sleep(4000);

  // ── The page itself, with everything on screen at once ──────────────────────
  await openOptions();

  const reportRows = Number(await inPage(`document.querySelectorAll('#report tbody tr').length`));
  notes.push(`report table audited: ${reportRows} row(s), from a real fill`);
  if (reportRows === 0) {
    findings.push({
      state: 'report', scheme: '-', id: 'report-absent', impact: 'serious',
      help: 'The report section never rendered a table, so its contrast and structure were not audited',
      tags: [], nodes: [{ target: '#report', summary: `filled "${landed}" but the report stayed empty` }],
    });
  }

  const openRule = async (label) => {
    await inPage(`(() => {
      const open = document.querySelector('#rules .rule-name[aria-expanded="true"]');
      if (open) open.click();
      return true;
    })()`);
    await sleep(150);
    await inPage(`(() => {
      [...document.querySelectorAll('#rules .rule-name')]
        .find((button) => button.textContent.trim().startsWith(${JSON.stringify(label)})).click();
      return true;
    })()`);
    await sleep(250);
  };

  // An undo offer, left standing for the rest of the editor audit.
  await inPage(`(() => {
    const row = [...document.querySelectorAll('#rules li.rule')]
      .find((candidate) => candidate.querySelector('.rule-name').textContent.trim().startsWith('Spare'));
    row.querySelector('.rule-delete').click();
    return true;
  })()`);
  await sleep(250);

  const stateOf = async () => String(await inPage(`JSON.stringify({
    rules: document.querySelectorAll('#rules li.rule').length,
    open: document.querySelectorAll('#rules .rule-body').length,
    problems: document.querySelectorAll('#rules .problem').length,
    flags: document.querySelectorAll('#rules .rule-flag').length,
    sources: document.querySelectorAll('#rules fieldset.sources input').length,
    undo: document.querySelectorAll('#rules .undo').length,
  })`));

  // Two editor states, because one rule is open at a time and the two things
  // worth auditing are in different rules: the invalid one renders the `!` flag
  // and the role="alert" problem list, the scoped one renders the six per-source
  // checkboxes inside their fieldset.
  for (const [name, label] of [['editor-invalid', 'Broken on purpose'], ['editor-scoped', 'Scoped rule']]) {
    await openRule(label);
    notes.push(`${name} audited: ${await stateOf()}`);
    for (const scheme of ['light', 'dark']) {
      const count = await audit(name, scheme);
      console.log(`  axe · ${name.padEnd(14)} · ${scheme.padEnd(5)} — ${count} violation(s)`);
    }
  }

  // ── Reflow (1.4.10) and text resize (1.4.4) ─────────────────────────────────
  // Neither is visible to axe. Reflow asks that content not require horizontal
  // scrolling at 320 CSS pixels; resize asks that it survive 200% text without
  // loss of content or function.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 800, deviceScaleFactor: 1, mobile: false,
  }, page);
  await sleep(250);
  const reflow = Number(await inPage(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  ));
  if (reflow > 1) {
    findings.push({
      state: 'editor', scheme: 'reflow', id: 'reflow-320',
      impact: 'serious', help: 'Content requires horizontal scrolling at 320 CSS pixels',
      tags: ['wcag21aa', 'wcag1410'],
      nodes: [{ target: 'html', summary: `${reflow}px of horizontal overflow at 320px wide` }],
    });
  }
  console.log(`  reflow · 320px — ${reflow > 1 ? `${reflow}px overflow` : 'no horizontal scrolling'}`);

  // 1.4.4 is a different question from 1.4.10 and gets its own viewport. Reflow
  // asks about 320 CSS pixels at normal text; resize asks that 200% text not
  // cost content or function at an ordinary window size. Applying both at once —
  // which this did first — tests a case no criterion requires and would have
  // driven the stylesheet to satisfy an invented one.
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false,
  }, page);
  await inPage(`document.documentElement.style.fontSize = '32px'`);
  await sleep(250);
  const resized = Number(await inPage(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  ));
  if (resized > 1) {
    findings.push({
      state: 'editor', scheme: 'resize', id: 'resize-200',
      impact: 'serious', help: 'Content is cut off horizontally at 200% text size',
      tags: ['wcag2aa', 'wcag144'],
      nodes: [{
        target: 'html',
        summary: `${resized}px of horizontal overflow at 200% text in a 1280px window`,
      }],
    });
  }
  console.log(`  resize · 200% text — ${resized > 1 ? `${resized}px overflow` : 'no loss of content'}`);
  await inPage(`document.documentElement.style.fontSize = ''`);
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, page);

  // ── The declared palette, measured ──────────────────────────────────────────
  // The stylesheet says these sit at or above 4.5:1 in both schemes. That was a
  // comment; this is the number. Sampled from resolved custom properties, so it
  // measures what the browser computed rather than what the source says.
  const contrast = async (scheme) => {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    }, page);
    await sleep(200);
    // `String.raw`, so the source below is the source that runs. This template is
    // JavaScript for another context to evaluate, and a plain template literal
    // makes every backslash in it mean something twice — the regex had to be
    // written `\\d` to arrive as `\d`, which is a transcription step between
    // what is written here and what the browser sees. Substitution still works;
    // raw only stops escape sequences being interpreted on the way out.
    return JSON.parse(String(await inPage(String.raw`(() => {
      const styles = getComputedStyle(document.documentElement);
      const value = (name) => styles.getPropertyValue(name).trim();
      const parse = (colour) => {
        const probe = document.createElement('span');
        probe.style.color = colour;
        document.body.append(probe);
        const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        probe.remove();
        return rgb;
      };
      const luminance = (rgb) => {
        const [r, g, b] = rgb.map((channel) => {
          const c = channel / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [luminance(parse(a)), luminance(parse(b))].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const bg = value('--ff-bg');
      return JSON.stringify(['--ff-fg', '--ff-muted', '--ff-ok', '--ff-bad'].map((name) => ({
        name,
        ratio: Math.round(ratio(value(name), bg) * 100) / 100,
      })));
    })()`)));
  };

  console.log('');
  for (const scheme of ['light', 'dark']) {
    for (const { name, ratio } of await contrast(scheme)) {
      const ok = ratio >= 4.5;
      console.log(`  contrast · ${scheme.padEnd(5)} · ${name.padEnd(11)} ${String(ratio).padStart(5)}:1 ${ok ? '✔' : '✖'}`);
      if (!ok) {
        findings.push({
          state: 'palette', scheme, id: 'palette-contrast',
          impact: 'serious', help: `${name} is below 4.5:1 on --ff-bg`,
          tags: ['wcag2aa', 'wcag143'],
          nodes: [{ target: name, summary: `measured ${ratio}:1 against the page background` }],
        });
      }
    }
  }

} catch (error) {
  findings.push({
    state: 'harness', scheme: '-', id: 'audit-failed', impact: 'critical',
    help: error instanceof Error ? error.message : String(error), tags: [], nodes: [],
  });
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  NFR-019 — WCAG 2.1 AA audit of the options page\n');
for (const note of notes) console.log(`  · ${note}`);

if (findings.length === 0) {
  console.log('\n✔ no WCAG 2.1 A/AA violations in either colour scheme, in either state\n');
  console.log('  Automated checking does not cover every AA criterion. The judgement-based');
  console.log('  ones are listed in the manual checklist at the foot of this file.\n');
} else {
  console.log('');
  for (const finding of findings) {
    console.log(`  ✖ [${finding.state}/${finding.scheme}] ${finding.id} (${finding.impact}) — ${finding.help}`);
    for (const tag of finding.tags) console.log(`      ${tag}`);
    for (const node of finding.nodes) {
      console.log(`      ${node.target}`);
      if (node.summary) {
        for (const line of String(node.summary).split('\n')) console.log(`        ${line}`);
      }
    }
  }
  console.error(`\n✖ ${findings.length} WCAG 2.1 A/AA finding(s)\n`);
  process.exit(1);
}

/*
 * ── The manual half ─────────────────────────────────────────────────────────
 *
 * Criteria automation cannot decide, checked by reading the page and its source.
 * Recorded here rather than in a document that would drift from the markup.
 *
 * 1.3.1 Info and Relationships — the rule list is an <ol>, because order is
 *   precedence and a numbered list says so; each rule's controls sit inside its
 *   <li>; the source scoping is a <fieldset> with a <legend>; every field is a
 *   <label> wrapping its control, so the association survives without `for`.
 * 1.3.2 Meaningful Sequence — one column, DOM order is reading order; no CSS
 *   reordering anywhere (no `order`, no `grid-auto-flow: dense`).
 * 1.4.1 Use of Colour — the two places colour appears both carry the fact in
 *   text as well: the report's outcome column contains the word, and an invalid
 *   rule shows a `!` with a title beside the sentence in its problem list.
 * 2.1.1 Keyboard / 2.1.2 No Trap — every control is a native button, input,
 *   select or textarea; reordering is buttons rather than a drag (BR-012-1),
 *   verified end-to-end in `e2e-options.mjs`. Nothing traps: no dialog, no
 *   custom key handling, no `tabindex` above 0 anywhere in the tree.
 * 2.4.3 Focus Order — every rebuild places focus deliberately, and the four
 *   cases (move, expand, delete, undo) are asserted in `e2e-options.mjs`.
 * 2.4.6 Headings and Labels — h1 names the page, h2 names each section, and the
 *   preview's h4 is deliberate rather than a slip: see the note in the audit's
 *   output about heading levels if axe ever flags it, and change the level
 *   rather than the audit.
 * 3.2.1 On Focus / 3.2.2 On Input — nothing navigates or submits on focus or on
 *   change. Editing writes to storage, which changes no context the user can see.
 * 3.3.1 Error Identification / 3.3.3 Error Suggestion — every validation
 *   failure names the cause and the correction in one sentence (NFR-020) and is
 *   rendered into a role="alert" beside the field that caused it.
 * 4.1.2 Name, Role, Value — the disclosure carries aria-expanded and is a real
 *   button; the move and delete buttons carry aria-label naming the rule they
 *   act on, because a page full of "Move up" is not a set of distinct names.
 * 4.1.3 Status Messages — the move announcement and the settings-changed notice
 *   go to a role="status" live region that is never focused.
 */
