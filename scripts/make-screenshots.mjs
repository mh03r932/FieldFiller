#!/usr/bin/env node
/**
 * Captures the five store screenshots listed in `docs/art_brief.md` §6, from
 * the real extension in a real Chromium — because a generated image of a fake
 * UI is a store-policy rejection, not just a taste problem.
 *
 * What it captures, in listing order (file names match):
 *
 *   01-filled-page.png       the reference page after a fill
 *   02-rule-editor.png       a rule expanded, match sources and generator showing
 *   03-profiles.png          a URL-matched profile, expanded
 *   04-domain-exclusions.png the options page scrolled to a domain exclusion
 *   05-report.png            the fill report, from the fill above
 *
 * Every capture is a 1280×800 viewport PNG — the size both stores accept, and
 * the one `store_listing.md` promises. The seed content is written into
 * `chrome.storage.local` before anything renders, so the options page shows a
 * lived-in configuration rather than empty lists.
 *
 * Usage: pnpm run build && node scripts/make-screenshots.mjs
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 *
 * Output: docs/art/screenshots/
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const REFERENCE_PAGE = join(ROOT, 'tests', 'fixtures', 'reference.html');
const OUT_DIR = join(ROOT, 'docs', 'art', 'screenshots');

/** Both stores' accepted size, and the one the listing copy promises. */
const WIDTH = 1280;
const HEIGHT = 800;

/** Out-of-process frames the reference fixture must have running before a fill. */
const CROSS_ORIGIN_FRAMES = 2;

/** How this harness picks the tab: the only one, or the active one. */
const TAB = 'tabs.length === 1 ? tabs[0] : tabs.find((candidate) => candidate.active)';

/**
 * A settings state worth photographing: rules that visibly fire on the fixture,
 * a scoped rule whose per-source checkboxes render, a profile with a URL
 * pattern, and field exclusions. Domains stay empty until the fill has been
 * captured — a non-empty domain list makes the background read the tab's
 * address before every fill, and a synthesised toolbar click cannot grant that
 * (`activeTab` follows a real gesture), so the fill would be refused.
 */
const SEED = {
  version: 1,
  locale: 'auto',
  rules: [
    {
      id: 'shot-1', label: 'Invoice reference', enabled: true,
      match: { mode: 'contains', pattern: 'short_code' },
      generator: { type: 'alphanumeric', template: 'INV-{digit:4}' },
      fromPersona: true,
    },
    {
      id: 'shot-2', label: 'Start date', enabled: true,
      match: { mode: 'exact', pattern: 'start_date' },
      sources: ['name', 'id', 'testId'],
      generator: { type: 'date', format: 'YYYY-MM-DD', from: '2026-01-04', to: '2026-12-28' },
      fromPersona: true,
    },
    {
      id: 'shot-3', label: 'Tracking code', enabled: true,
      match: { mode: 'regex', pattern: '^track_' },
      generator: { type: 'number', min: 100000, max: 999999, decimals: 0 },
      fromPersona: false,
    },
    {
      id: 'shot-4', label: 'Legacy promo code', enabled: false,
      match: { mode: 'contains', pattern: 'promo' },
      generator: { type: 'list', items: ['SPRING', 'SUMMER'] },
      fromPersona: false,
    },
  ],
  profiles: [
    {
      id: 'shot-p1', label: 'Staging sites', enabled: true,
      urls: ['*.staging.example.com/*'],
      rules: [
        {
          id: 'shot-p1-r1', label: 'Staging reference', enabled: true,
          match: { mode: 'contains', pattern: 'short_code' },
          generator: { type: 'constant', value: 'STAGING-42' },
          fromPersona: true,
        },
      ],
    },
  ],
  exclusions: {
    fields: [
      { mode: 'contains', pattern: 'captcha' },
      { mode: 'contains', pattern: 'newsletter' },
    ],
    domains: [],
  },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: false,
    maxLengths: { textarea: 120 },
    consentKeywords: ['terms', 'privacy'],
    confirmationKeywords: ['confirm', 'repeat'],
  },
  passwords: { length: 16, upper: true, lower: true, digits: true, symbols: true },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
};

/** The same state with the domain exclusions the fourth shot photographs. */
const SEED_WITH_DOMAINS = {
  ...SEED,
  exclusions: { ...SEED.exclusions, domains: ['*.bank.example/*', 'mail.internal.example/*'] },
};

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-shots-'));
let chrome;
let cdp;

const html = readFileSync(REFERENCE_PAGE, 'utf8');

// A second origin, so the cross-origin frames in the fixture are genuinely
// cross-origin and their fields join the fill (same substitution e2e-chrome makes).
const crossOriginServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>cross-origin</title>' +
      '<label>Cross name <input name="xorigin_name" autocomplete="given-name"></label>' +
      '<label>Cross email <input name="xorigin_email" type="email"></label>',
  );
});
await new Promise((resolve) => crossOriginServer.listen(0, '127.0.0.1', resolve));
const crossOriginUrl = `http://localhost:${crossOriginServer.address().port}/`;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    html
      .replace(
        '<iframe id="cross-origin" title="cross-origin frame"',
        `<iframe id="cross-origin" title="cross-origin frame" src="${crossOriginUrl}"`,
      )
      .replace(
        '<iframe id="cross-origin-twin" title="second frame, same URL"',
        `<iframe id="cross-origin-twin" title="second frame, same URL" src="${crossOriginUrl}"`,
      ),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));

  const initial = (await cdp.send('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'page',
  );
  const targetId =
    initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Runtime.enable', {}, page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, page);

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

  /** One viewport PNG, written under its listing name, with its size reported. */
  const capture = async (name) => {
    await sleep(250); // let a scroll or an expansion repaint first
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
    const file = join(OUT_DIR, name);
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(file, bytes);
    // The IHDR width/height, read back so a wrong-sized capture is said so here.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    console.log(`  ${name}  ${width}×${height}  ${(bytes.length / 1024).toFixed(1)} kB`);
  };

  const scrollTo = (selector) =>
    inPage(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`);

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

  // ── The fill, on the fixture, with the seed's rules firing ──────────────────
  await cdp.send('Page.navigate', { url: pageUrl }, page);

  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const frames = targetInfos.filter(
      (target) => target.type === 'iframe' && target.url.startsWith('http://'),
    );
    if (frames.length >= CROSS_ORIGIN_FRAMES) break;
    await sleep(100);
  }
  await waitForAgent(cdp, workerSession, TAB);

  const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
    const tab = ${TAB};
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
  if (landed === '') throw new Error('the fill never landed in the reference page');
  // The report is built when the last frame has reported, which is after the
  // values land — the same wait `a11y-options.mjs` pays before reading it.
  await sleep(4000);

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Capturing into ${OUT_DIR}:`);
  // The fill scrolls the page (a control it fills is brought into view), so the
  // top of the page — its heading and the identity fields whose coherence is
  // the point — has to be returned to before this capture.
  await inPage('window.scrollTo(0, 0)');
  await capture('01-filled-page.png');

  // ── The options page, and the four sections worth photographing ─────────────
  await openOptions();

  // The report first: it is requested once at load, so the fill above is what
  // it shows, and nothing later in this run can put it on screen again.
  await scrollTo('#report-heading');
  await capture('05-report.png');

  // A rule expanded, showing its match sources and generator. The scoped "Start
  // date" rule renders the six per-source checkboxes, which is the point.
  await scrollTo('#rules-heading');
  await inPage(`(() => {
    const button = [...document.querySelectorAll('#rules .rule-name')]
      .find((candidate) => candidate.textContent.trim().startsWith('Start date'));
    if (button === undefined) throw new Error('the seeded rule is not in the list');
    button.click();
    return true;
  })()`);
  await inPage(`(() => {
    const item = [...document.querySelectorAll('#rules li.rule')]
      .find((candidate) => candidate.querySelector('.rule-name').textContent.trim().startsWith('Start date'));
    item.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await capture('02-rule-editor.png');

  // The profile, expanded so its URL pattern and its own rule are showing.
  await inPage(`(() => {
    const button = document.querySelector('#profiles .profile-name');
    if (button === undefined) throw new Error('the seeded profile is not in the list');
    button.click();
    return true;
  })()`);
  await scrollTo('#profiles-heading');
  await capture('03-profiles.png');

  // Domain exclusions last: seeding them is what would have refused the fill,
  // so they go in after every capture that depends on one.
  await inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(SEED_WITH_DOMAINS)} })`);
  await openOptions();
  await scrollTo('#domain-exclusions-heading');
  await capture('04-domain-exclusions.png');

  console.log('done.');
} finally {
  await closeChromium({ chrome, cdp, profileDir });
  crossOriginServer.close();
  server.close();
}
