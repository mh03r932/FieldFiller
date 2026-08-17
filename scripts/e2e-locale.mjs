#!/usr/bin/env node
/**
 * Both locales end to end, in a real Chromium with the extension loaded.
 *
 * `tests/corpus.test.ts` checks the data and `tests/persona.test.ts` checks that
 * a generated record keeps its pairings. Neither can reach the path this covers:
 * a locale *chosen* — written to `chrome.storage`, read back through the
 * tolerant parser, resolved past `auto`, used to select a corpus, turned into a
 * record, and written onto a real page by the real fill.
 *
 * The reason it exists is de-CH. Every other harness runs on a headless Chrome
 * whose UI language resolves to en-US, so until this was written the Swiss
 * corpus had never produced a value in a browser at all — its phone numbers and
 * four-digit postcodes were exercised only in unit tests, against the same
 * tables that generated them.
 *
 * What is asserted is *shape*, never content: `EXPECTED` says what a postcode
 * has to look like in each country. Asserting the values would mean copying the
 * corpus into the harness, and a check that restates its subject proves nothing.
 *
 * Usage: pnpm run build && pnpm run locale:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachToWorker, derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'reference.html');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-locale-'));
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

/**
 * What each locale must produce, expressed as shape rather than as content.
 *
 * The corpus decides *which* town; this decides what a town's postcode has to
 * look like in that country. Asserting the exact values would mean copying the
 * corpus into the harness, and a check that restates its subject proves nothing.
 *
 * The reference page's `country` field is a `<select>`, so it is answered from
 * the options the page offers rather than from the persona (UC-004 A3). It is
 * not checked here for that reason — the persona's own country is covered by
 * the unit tests, where it is not competing with a fixed option list.
 */
const EXPECTED = {
  'en-US': {
    phone: /^\+1 \d{3}-555-01\d{2}$/,
    postcode: /^\d{5}$/,
  },
  'de-CH': {
    phone: /^\+41 7[5-9] \d{3} \d{2} \d{2}$/,
    postcode: /^\d{4}$/,
  },
};

const filledPerLocale = {};

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
   * Fills the reference page with one locale selected, and reads back what
   * landed on it.
   *
   * The locale goes through `chrome.storage` rather than being injected, so the
   * whole path is exercised: stored value, tolerant parse, `auto` resolution
   * bypassed by an explicit choice, corpus selection, record, fill.
   */
  async function fillWith(locale) {
    await inWorker(`chrome.storage.local.set({ settings: { version: 1, locale: '${locale}' } }).then(() => 'ok')`);
    await cdp.send('Page.navigate', { url: pageUrl }, page);
    await sleep(1200);

    const fired = await inWorker(`chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
      if (tab === undefined) return 'no tab';
      chrome.action.onClicked.dispatch(tab);
      return 'ok';
    }).catch((error) => 'threw: ' + error.message)`);
    if (fired !== 'ok') throw new Error(`the toolbar trigger did not fire — ${String(fired)}`);

    // Every field the checks below read, not a subset of them. A fill writes its
    // controls in a loop, and this snapshot is taken from outside the page — so
    // a predicate satisfied by three fields can capture a frame in which the
    // other two have not been reached yet, and the assertion on *those* then
    // fails as though the corpus were at fault. The window is small and the
    // failure direction is safe, but a harness that fails for a reason it does
    // not name is the thing that gets rerun until it goes green.
    const read = async () =>
      JSON.parse(
        String(
          await inPage(`(() => {
        const value = (name) => document.querySelector('[name=' + name + ']')?.value ?? '';
        return JSON.stringify({
          given: value('given_name'), phone: value('phone'), postcode: value('postcode'),
          town: value('town'), street: value('street'),
        });
      })()`),
        ),
      );
    const complete = (candidate) => Object.values(candidate).every((value) => value !== '');

    let filled;
    for (let elapsed = 0; elapsed < 6000 && filled === undefined; elapsed += 200) {
      await sleep(200);
      const candidate = await read();
      if (complete(candidate)) filled = candidate;
    }
    if (filled === undefined) throw new Error(`the ${locale} fill never produced a complete record`);

    // Wait for the *operation* to close, not just for values to land. A second
    // invocation while one is running is ignored on purpose (UC-001 A7), so a
    // harness that fills twice has to let the first finish or it scores the
    // engine's correct refusal as a missing fill. The badge is set when the
    // operation completes, which makes it the signal — and this cost an hour to
    // learn, which is why it is written down here.
    let settled = false;
    for (let elapsed = 0; elapsed < 8000 && !settled; elapsed += 200) {
      const badge = await inWorker(`chrome.tabs.query({}).then((t) =>
        chrome.action.getBadgeText({ tabId: (t.find((x) => x.active) ?? t[0]).id }))`);
      settled = String(badge ?? '') !== '';
      if (!settled) await sleep(200);
    }
    // Asserted rather than merely waited out. Falling through this loop silently
    // means the values arrived and the operation never signalled that it had
    // finished — a real defect, and one whose only other symptom is the *next*
    // fill being ignored as already running, which reads as an unrelated failure
    // one locale later.
    check(`${locale}: the fill signalled that the operation had completed`, settled,
      'the badge never appeared within 8 s of the values landing');

    // Re-read once the operation has closed, so what is asserted is the settled
    // page rather than the first frame that satisfied the predicate.
    return settled ? await read() : filled;
  }

  for (const locale of ['en-US', 'de-CH']) {
    const filled = await fillWith(locale);
    filledPerLocale[locale] = filled;
    const expected = EXPECTED[locale];

    check(`${locale}: the phone number is written the way that country writes one`,
      expected.phone.test(filled.phone), `phone=${JSON.stringify(filled.phone)}`);
    check(`${locale}: the postal code has that country's shape`,
      expected.postcode.test(filled.postcode), `postcode=${JSON.stringify(filled.postcode)}`);
    check(`${locale}: the address and the person both arrived`,
      filled.given !== '' && filled.street !== '' && filled.town !== '',
      JSON.stringify(filled));
  }

  // The check that makes the other eight mean something: a setting nobody reads
  // would let both runs produce identical output and every shape assertion above
  // would still pass for one of the two.
  check('the setting is what selects the corpus, not the seed',
    filledPerLocale['en-US'].town !== filledPerLocale['de-CH'].town &&
      filledPerLocale['en-US'].phone !== filledPerLocale['de-CH'].phone,
    `en-US=${filledPerLocale['en-US'].town} de-CH=${filledPerLocale['de-CH'].town}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  server.close();
  chrome?.kill();
  await sleep(200);
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`  (left a temp profile behind: ${profileDir})`);
  }
}

console.log('\n  The corpus, per locale, through storage\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}
for (const [locale, filled] of Object.entries(filledPerLocale)) {
  console.log(`\n  ${locale}: ${filled.given}, ${filled.street}, ${filled.postcode} ${filled.town}`);
  console.log(`  ${' '.repeat(locale.length)}  ${filled.phone}`);
}

if (failures.length > 0) {
  console.error('\n✖ locale end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ each locale produces a record that belongs to its country\n');
