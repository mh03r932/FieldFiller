#!/usr/bin/env node
/**
 * UC-002, UC-003 and UC-008 against a real Chromium with the extension loaded.
 *
 * The unit tests in `tests/scope.test.ts` decide whether the DD-008 ladder is
 * *correct*; this decides whether it is *reachable*. Everything between the two
 * lives outside happy-dom: the context menu's `frameId`, `chrome.tabs.get`
 * returning a URL under `activeTab`, the badge, and the fact that the agent has
 * to have seen the right-click itself because Chrome will not tell us which
 * element it was (DD-001).
 *
 * Each case reloads the fixture first. Scope is the thing under test, so a run
 * that inherited another case's writes would be scoring the wrong page — and the
 * failure would read as a scope leak, which is exactly the defect this exists to
 * catch.
 *
 * Usage: pnpm run build && pnpm run scopes:chrome
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachToWorker, closeChromium, derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'scopes.html');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-scopes-'));
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

  /** Every filled control, by name — the shape every assertion below reads. */
  /**
   * Finds a control anywhere in the page, including inside open shadow roots.
   *
   * The fixture's `<sl-input>` keeps its real `<input>` in one, so a plain
   * `document.querySelector` cannot see it — which is the same blindness the
   * agent had until the anchor learned to reach through retargeting.
   */
  const DEEP_QUERY = `(selector) => {
    const direct = document.querySelector(selector);
    if (direct !== null) return direct;
    for (const element of document.querySelectorAll('*')) {
      const found = element.shadowRoot?.querySelector(selector) ?? null;
      if (found !== null) return found;
    }
    return null;
  }`;

  const DEEP_INPUTS = `(() => {
    const found = [...document.querySelectorAll('input[name]')];
    for (const element of document.querySelectorAll('*')) {
      if (element.shadowRoot) found.push(...element.shadowRoot.querySelectorAll('input[name]'));
    }
    return found;
  })()`;

  const filledNames = async () =>
    inPage(`${DEEP_INPUTS}
      .filter((input) => input.value !== '')
      .map((input) => input.name)
      .sort()`);

  async function reload() {
    await cdp.send('Page.navigate', { url: pageUrl }, page);
    await sleep(900);
  }

  /**
   * Points at a control the way a user does, then invokes a scope from the menu.
   *
   * The right-click is dispatched in the page rather than synthesised through
   * the Input domain because what matters is that the *agent* saw it: the agent
   * listens in capture on the document, and Chrome's menu callback carries no
   * element identifier for it to use instead (DD-001).
   */
  /**
   * A right-click the browser sends, at the element's own coordinates.
   *
   * Not `dispatchEvent(new MouseEvent('contextmenu'))`, which is what this used
   * to do: an event a page script dispatches carries `isTrusted === false`, and
   * the agent ignores those on purpose, so a page cannot plant the anchor a
   * later fill uses. Dispatching one here meant the harness was driving the
   * extension through an input production refuses — it passed while the guard
   * did not exist, and every rung check failed the moment it did.
   *
   * `Input.dispatchMouseEvent` goes in where a real click does, so the event is
   * trusted and the pointer path this harness exists to exercise is the path
   * that actually runs. Focusing the element instead would also have worked and
   * would have tested the wrong thing.
   */
  async function rightClick(selector) {
    const at = await inPage(`(() => {
      const element = (${DEEP_QUERY})('${selector}');
      if (element === null) return null;
      element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    if (at === null) throw new Error(`nothing matched ${selector} to right-click`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 },
        page,
      );
    }
  }

  async function pointAndFill(selector, menuItemId) {
    await reload();
    if (selector !== undefined) await rightClick(selector);
    const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
      if (tab === undefined) return 'no tab';
      chrome.contextMenus.onClicked.dispatch({ menuItemId: '${menuItemId}', frameId: 0 }, tab);
      return 'ok';
    }).catch((error) => 'threw: ' + error.message)`);
    if (fired !== 'ok') throw new Error(`the context menu did not fire — ${String(fired)}`);
    await sleep(1800);
  }

  const badgeTitle = async () =>
    inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.getTitle({ tabId: (tabs.find((t) => t.active) ?? tabs[0]).id }))`);

  const badgeText = async () =>
    inWorker(`chrome.tabs.query({}).then((tabs) =>
      chrome.action.getBadgeText({ tabId: (tabs.find((t) => t.active) ?? tabs[0]).id }))`);

  // ── UC-002, rung 1: the page said so ────────────────────────────────────────
  await pointAndFill('[name="a_one"]', 'current-form');
  check('form scope fills the owning form and nothing else',
    JSON.stringify(await filledNames()) === JSON.stringify(['a_one', 'a_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002, rung 2: the author said so without a <form> ─────────────────────
  await pointAndFill('[name="b_one"]', 'current-form');
  check('form scope honours role="form" where there is no form element',
    JSON.stringify(await filledNames()) === JSON.stringify(['b_one', 'b_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002, rung 3: the smallest block with a submit control ────────────────
  await pointAndFill('[name="g_one"]', 'current-form');
  check('form scope falls back to the block holding a submit control',
    JSON.stringify(await filledNames()) === JSON.stringify(['g_one', 'g_two']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002 A3: refuses rather than widening ─────────────────────────────────
  await pointAndFill('[name="d_one"]', 'current-form');
  const afterRefusal = await filledNames();
  check('form scope refuses rather than widening to the page',
    afterRefusal.length === 0,
    `filled ${JSON.stringify(afterRefusal)} — an anchored narrowing was overridden (BR-002-2)`);

  // ── UC-003: exactly one control ─────────────────────────────────────────────
  await pointAndFill('[name="b_one"]', 'selected-input');
  check('single-control scope fills one control',
    JSON.stringify(await filledNames()) === JSON.stringify(['b_one']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-002 and UC-003 through an open shadow root (FR-008, C-006) ───────────
  //
  // The one case only a browser can judge. A listener on the document sees
  // `event.target` retargeted to the shadow host, so the agent recorded
  // `<sl-input>` — not a fillable kind — and the single-control scope refused on
  // exactly the design systems the walk goes out of its way to support. happy-dom
  // does not retarget, so no unit test can fail on it; this is the check that can.
  await pointAndFill('[name="e_one"]', 'selected-input');
  check('single-control scope reaches a control inside an open shadow root',
    JSON.stringify(await filledNames()) === JSON.stringify(['e_one']),
    `filled ${JSON.stringify(await filledNames())}`);

  // And the form around it is in the light DOM outside the component, which the
  // ladder only finds by hopping out of the root it started in.
  await pointAndFill('[name="e_one"]', 'current-form');
  check('form scope crosses the shadow boundary to the form outside it',
    JSON.stringify(await filledNames()) === JSON.stringify(['e_one']),
    `filled ${JSON.stringify(await filledNames())}`);

  // ── UC-001 still works, from the same fixture ───────────────────────────────
  await pointAndFill(undefined, 'all-inputs');
  const wholePage = await filledNames();
  check('page scope still fills everything, shadow content included',
    wholePage.length === 9 && wholePage.includes('e_one'),
    `filled ${wholePage.length} of 9: ${JSON.stringify(wholePage)}`);

  // ── UC-008 ─────────────────────────────────────────────────────────────────
  //
  // What is provable here and what is not, stated rather than glossed. Once any
  // exclusion exists the background reads the tab's URL, and it may do so only
  // through `activeTab` (BR-008-2) — a grant that follows a *user gesture*. A
  // menu click synthesised over CDP is not one, so `tabs.get()` returns no URL
  // and UC-008 A1 is what runs: the tab is treated as excluded because its
  // address could not be read.
  //
  // That is the safe direction, and asserting it is worth doing — A1 is the
  // branch where a mistake means filling a page that should have been left
  // alone. The *pattern-matching* path is covered by `matchesGlob` in
  // `tests/scope.test.ts` instead, and the gap is recorded against FR-037.
  await inWorker(`chrome.storage.local.set({
    settings: { version: 1, exclusions: { fields: [], domains: ['127.0.0.1/*'] } },
  }).then(() => 'ok')`);

  await pointAndFill('[name="a_one"]', 'current-form');
  const afterExclusion = await filledNames();
  check('a tab whose address cannot be read is not filled (UC-008 A1)',
    afterExclusion.length === 0,
    `filled ${JSON.stringify(afterExclusion)}`);
  check('and the toolbar says so, without being erased by the previous fill',
    (await badgeText()) === 'off',
    `badge showed ${JSON.stringify(await badgeText())}`);
  // UC-008 A1 says the system reports that it could not establish where it was
  // being asked to act. It used to substitute a sentence where the pattern goes,
  // so the tooltip asserted a list entry that does not exist and sent the user
  // looking for it. The badge alone could not catch that — it reads 'off' either
  // way, which is why this assertion is on the words.
  const excludedTitle = await badgeTitle();
  check('and the tooltip says the address could not be read, not that a pattern matched',
    excludedTitle.includes('could not be read') && !excludedTitle.includes('is on your excluded list'),
    `tooltip was ${JSON.stringify(excludedTitle)}`);

  await pointAndFill(undefined, 'all-inputs');
  check('the refusal applies to the page scope too',
    (await filledNames()).length === 0,
    `filled ${JSON.stringify(await filledNames())} — a scope is not a route around exclusion (BR-008-5)`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-002, UC-003 and UC-008 — scopes and exclusion\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ scope end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ every scope reaches exactly the controls it names\n');
