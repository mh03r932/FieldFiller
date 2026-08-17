#!/usr/bin/env node
/**
 * The fill engine, run against the reference page in real Firefox (NFR-014).
 *
 * **What this closes.** NFR-014 has two sentences. The first — an automated
 * browser test filling the reference page — was satisfied in Chromium and not in
 * Firefox, where `smoke:firefox` proved the add-on installs and filled nothing.
 * The second — "engine unit tests run identically against both targets" — was
 * satisfied by neither: the unit suite runs once, under happy-dom, which is not
 * an engine we ship to.
 *
 * This runs the real engine against the real reference fixture in Gecko. NFR-015
 * is what makes that cheap rather than a second product: `runFill` takes a
 * `Document` and a callback and touches no extension API, so the code under test
 * here is the same code the page agent runs, with the background's half supplied
 * by calling the real generators in the page.
 *
 * **What it deliberately does not cover, and why.** The extension's own trigger.
 * A fill starts from a toolbar click, a context menu item or a keyboard
 * shortcut, and none can be synthesised: WebDriver input is dispatched into the
 * content area and browser-level shortcut handling is deliberately out of its
 * reach — measured here, in both headless and headful Firefox, with the correct
 * BiDi modifier codepoints. Chromium has the mirror-image limitation for
 * `activeTab`. So the messaging round trip in Firefox is covered by
 * `smoke:firefox` (the add-on installs, `gecko.id` is honoured, a page loads
 * with the agent in it), the engine is covered here, and the join between them
 * is the remainder — stated against NFR-014 rather than implied to be covered.
 *
 * Usage: pnpm run engine:firefox
 *   FIREFOX_PATH=…  override the browser binary
 *   HEADFUL=1       show the window
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeFirefox, launchFirefox, sleep } from './lib/firefox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'reference.html');
const BUNDLE = join(ROOT, '.output', 'firefox-engine', 'engine-suite.js');

// Built here rather than expected to exist. This harness is the only thing that
// uses the bundle, so making the caller remember a second build step is a way to
// test a stale one — which is the failure that looks like a passing run.
execFileSync(
  join(ROOT, 'node_modules', '.bin', 'vite'),
  ['build', '--config', join(ROOT, 'scripts', 'firefox', 'vite.config.mjs')],
  { stdio: 'inherit' },
);
if (!existsSync(BUNDLE)) {
  console.error('✖ the engine bundle was not produced.');
  process.exit(1);
}

const fixture = readFileSync(FIXTURE, 'utf8');
const bundle = readFileSync(BUNDLE, 'utf8');

/**
 * The fixture with the suite appended, assembled here rather than on disk.
 *
 * `tests/fixtures/reference.html` is loaded by four other harnesses through a
 * real extension, and a `<script>` tag added for this one would run in all of
 * them.
 */
const page = fixture.replace('</body>', '<script type="module" src="/engine-suite.js"></script></body>');

const server = createServer((request, response) => {
  if (request.url === '/engine-suite.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(bundle);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail });
  if (condition !== true) failures.push(`${name} — ${detail}`);
}

let session;

try {
  session = await launchFirefox();
  const { bidi } = session;

  const context = (await bidi.send('browsingContext.create', { type: 'tab' })).context;
  await bidi.send('browsingContext.navigate', { context, url: pageUrl, wait: 'complete' });

  const evaluate = async (expression) => {
    const outcome = await bidi.send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 10, maxDomDepth: 0 },
    });
    if (outcome.type === 'exception') {
      throw new Error(`in-page: ${outcome.exceptionDetails?.text ?? 'threw'}`);
    }
    return outcome.result;
  };

  // The module is loaded with `type=module`, so it is deferred — wait for the
  // function it defines rather than for the load event, which is the condition
  // that actually matters and the one a sleep would be standing in for.
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    const probe = await evaluate('typeof window.__fieldfillerRun === "function"');
    ready = probe?.value === true;
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('the engine bundle never loaded in Firefox');

  // Serialized as JSON rather than as a BiDi object graph: the result contains a
  // map of every named control, and BiDi's structured serialization truncates by
  // depth and property count in ways that are the harness's problem rather than
  // the engine's.
  const raw = await evaluate('window.__fieldfillerRun().then((r) => JSON.stringify(r))');
  const result = JSON.parse(String(raw?.value ?? '{}'));

  const values = result.values ?? {};
  const kinds = result.kinds ?? {};
  const filled = (result.outcomes ?? []).filter((outcome) => outcome.status === 'filled');
  const failed = (result.outcomes ?? []).filter((outcome) => outcome.status === 'failed');

  check('the engine completes a fill in Firefox',
    (result.outcomes ?? []).length > 0, 'no outcomes came back at all');

  check('and settles rather than stopping at a bound',
    result.capped === undefined,
    `capped: ${String(result.capped)} after ${String(result.passes)} passes`);

  check('every control kind the fixture declares was described',
    Object.keys(kinds).length >= 12,
    `kinds seen: ${JSON.stringify(kinds)}`);

  check('no control failed verification',
    failed.length === 0,
    `${failed.length} failed: ${JSON.stringify(failed.slice(0, 3))}`);

  // The specific writes worth naming, because each exercises a different piece
  // of engine-specific behaviour rather than merely being another text box.
  const named = [
    ['email', 'a typed value reaches an ordinary input'],
    ['notes', 'a textarea receives a paragraph, not a phrase (ND-10)'],
    ['password', 'a password field is filled'],
    ['short_code', 'a maxlength is honoured in Gecko'],
  ];
  for (const [name, what] of named) {
    check(what, typeof values[name] === 'string' && values[name].length > 0,
      `[name=${name}] = ${JSON.stringify(values[name])}`);
  }

  check('the field with maxlength=5 is cut to it',
    (values['short_code'] ?? '').length === 5,
    `short_code = ${JSON.stringify(values['short_code'])}`);

  check('a confirmation field repeats the field it confirms (UC-006)',
    values['pw'] !== undefined && values['pw'] === values['pw_second'],
    `pw=${JSON.stringify(values['pw'])} pw_second=${JSON.stringify(values['pw_second'])}`);

  check('more than half the page was filled, so the checks above are not all of it',
    filled.length > 15, `${filled.length} controls filled`);

  console.log(`\n  ${filled.length} filled · ${String(result.passes)} pass(es) · kinds: ${Object.keys(kinds).sort().join(', ')}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await closeFirefox(session ?? {});
}

console.log('\n  NFR-014 — the fill engine against the reference page, in Gecko\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ Firefox engine run failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ the engine fills the reference page in Firefox, not only in Chromium\n');
