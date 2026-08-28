#!/usr/bin/env node
/**
 * UC-029: a configuration into the browser's own synchronised storage, and back
 * out of it as though from another device.
 *
 * `tests/sync.test.ts` decides whether the layout, the completeness check, the
 * delta and the two plans are right. This decides whether the *feature* is:
 * whether turning the toggle on writes a replica, whether a replica written by
 * somebody else is adopted here as one replacement, whether the ceiling stops
 * rather than truncates, and whether the standing sentences are on screen before
 * any of it. Every check below reads a real `chrome.storage.sync`.
 *
 * **A signed-out Chromium keeps synchronised data locally, and that is what
 * makes this testable at all.** No account is signed in, so nothing leaves the
 * machine; what the browser still does is enforce the quotas and fire
 * `storage.onChanged` for the `sync` area, which is every mechanism this feature
 * turns on. Writing to `chrome.storage.sync` from the worker is therefore an
 * honest stand-in for a second device: it is the same store arriving by the same
 * event, and the extension cannot tell the difference — which is precisely
 * A4's point, that no extension API reports where a synchronised value came
 * from.
 *
 * What it does not cover, stated rather than implied.
 *
 *   · **Two browsers actually signed into one account.** That needs credentials
 *     and a network, which this project has neither of by design (G3), so the
 *     *carrying* half of FR-058 is the platform's and the *writing* half is
 *     covered here.
 *   · **Firefox.** Not for want of trying: BiDi refuses to navigate a content
 *     context to a `moz-extension:` URL, so no harness here can reach this
 *     add-on's options page or its storage — the same wall `e2e-firefox.mjs`
 *     runs the engine with no extension to get around. What *was* measured in a
 *     real Gecko on 2026-08-28, by installing a purpose-built probe add-on
 *     whose content script does the asking, is every platform semantic this
 *     feature stands on: writes accepted with no account signed in, both quotas
 *     enforced, `storage.onChanged` firing with `areaName === 'sync'`, the exact
 *     refusal wording `isQuotaFailure` has to classify, and the fact that
 *     Firefox returns stored objects in insertion order where Chromium
 *     alphabetises them. The module note in `src/lib/sync.ts` records all five.
 *     What remains uncovered there is this extension's own *wiring* — the same
 *     structural gap the project already carries for Firefox, not a new one.
 *
 * Usage: pnpm run build && pnpm run sync:chrome
 *   CHROME_PATH=…  override the browser binary
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachToWorker,
  canonicalState,
  clickWithGesture,
  closeChromium,
  derivedExtensionId,
  launchChromium,
  sleep,
} from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

const rule = (id, extra = {}) => ({
  id,
  label: `Rule ${id}`,
  enabled: true,
  match: { mode: 'contains', pattern: id },
  generator: { type: 'email' },
  fromPersona: true,
  ...extra,
});

/** The base every fixture below varies, with something in most lists. */
const base = (rules, profiles = []) => ({
  version: 1,
  locale: 'de-CH',
  rules,
  profiles,
  exclusions: { fields: [{ mode: 'exact', pattern: 'coupon' }], domains: ['*.bank.example'] },
  behaviour: {
    dispatchEvents: true,
    skipHidden: true,
    skipPreFilled: true,
    maxLengths: { textarea: 200 },
    consentKeywords: ['accept'],
    confirmationKeywords: ['confirm'],
  },
  passwords: { length: 20, upper: true, lower: true, digits: true, symbols: false },
  sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
  triggers: { contextMenu: true },
});

/** Eleven rules: two full shards and a third holding three, so the sharding is visible in the store. */
const HERE = base([
  rule('kundenstrasse', { label: 'Kundenstraße' }),
  ...Array.from({ length: 10 }, (_, n) => rule(`local${n}`)),
]);

/** What "another device" holds. Deliberately a different size, so an adoption is unmistakable. */
const THERE = base([rule('remote-a'), rule('remote-b')], [
  { id: 'p1', label: 'Remote staging', enabled: true, urls: ['https://staging.example.com/*'], rules: [rule('pr1')] },
]);

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-sync-e2e-'));

let chrome;
let cdp;

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

  const waitFor = async (expression, whatFailed) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inPage(expression)) === true) return;
      await sleep(100);
    }
    throw new Error(`${whatFailed} (waited 10 s for \`${expression}\`)`);
  };

  /** The same wait, asked of the worker: the replica is not something the page can see. */
  const waitInWorker = async (expression, whatFailed) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inWorker(expression)) === true) return;
      await sleep(100);
    }
    throw new Error(`${whatFailed} (waited 10 s for \`${expression}\`)`);
  };

  const stored = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings ?? null))`,
    )));

  const replica = async () =>
    JSON.parse(String(await inWorker(`chrome.storage.sync.get(null).then((s) => JSON.stringify(s))`)));

  const prefs = async () =>
    JSON.parse(String(await inWorker(
      `chrome.storage.local.get('sync').then((s) => JSON.stringify(s.sync ?? null))`,
    )));

  const seed = async (settings) =>
    inWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);

  const clearSync = async () => inWorker(`chrome.storage.sync.clear().then(() => true)`);

  const textOf = async (selector) =>
    String(await inPage(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`));

  const openOptions = async () => {
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, page);
    await waitFor(
      `document.querySelector('#sync .sync-view input[type="checkbox"]') !== null`,
      'the sync section never rendered',
    );
  };

  /**
   * The rate gate, wound back.
   *
   * The gate is 72 s between write calls (NFR-023's bound, met by arithmetic),
   * which is correct for a product and impossible for a harness that makes
   * several writes in a row. Clearing `lastWriteAt` is not a way around the
   * bound — the bound is asserted directly further down, against the constant —
   * it is how the *other* checks get to run at all. Written as its own helper so
   * that every place it happens is visible rather than folded into a seed.
   */
  const openGate = async () => {
    await inWorker(`(async () => {
      const { sync } = await chrome.storage.local.get('sync');
      await chrome.storage.local.set({ sync: { ...(sync ?? {}), lastWriteAt: 0 } });
      return true;
    })()`);
  };

  // ── BR-029-3: the two sentences are there before the feature is ────────────
  await seed(HERE);
  await clearSync();
  await openOptions();

  check('synchronisation ships off (BR-029-1)',
    (await inPage(`document.querySelector('#sync .sync-view input[type="checkbox"]').checked === false`)) === true,
    'the toggle was already on');

  const ceiling = await textOf('#sync .sync-standing-ceiling');
  const conflict = await textOf('#sync .sync-standing-conflict');
  check('the ceiling sentence stands on screen with the feature off (BR-029-3)',
    ceiling.includes('399') && /stops/i.test(ceiling) && /never carries part/i.test(ceiling),
    `ceiling=${JSON.stringify(ceiling)}`);
  check('and so does the conflict sentence, naming what a conflict discards',
    conflict.includes('8') && /later change wins/i.test(conflict) && /discarded/i.test(conflict),
    `conflict=${JSON.stringify(conflict)}`);

  const offStatus = await textOf('#sync .sync-status');
  check('the status line claims nothing about other devices while off (BR-029-6)',
    /this device only/i.test(offStatus) && !/up to date/i.test(offStatus),
    `status=${JSON.stringify(offStatus)}`);

  // ── Steps 1, 2 and 4: an empty store is seeded from this device ────────────
  await clickWithGesture(cdp, page, '#sync .sync-view input[type="checkbox"]');
  await waitInWorker(
    `chrome.storage.sync.get('index').then((s) => s.index !== undefined)`,
    'turning synchronisation on never wrote a replica',
  );

  const seeded = await replica();
  check('the replica is sharded eight rules to a key (step 4, DD-002 L3)',
    seeded['rules.0']?.length === 8 && seeded['rules.1']?.length === 3 && seeded['rules.2'] === undefined,
    `shards=${JSON.stringify(Object.keys(seeded).filter((k) => k.startsWith('rules.')))}`);
  check('and the index names the counts, which is what makes an incomplete arrival detectable',
    seeded.index?.rules === 11 && seeded.index?.profiles === 0,
    `index=${JSON.stringify(seeded.index)}`);
  check('every other section is one key of its own, in the canonical shape',
    seeded.passwords?.length === 20 && seeded.locale === 'de-CH' && seeded.exclusions?.domains?.[0] === '*.bank.example',
    `keys=${JSON.stringify(Object.keys(seeded).sort())}`);

  check('the toggle is not in the replica — it never travels (BR-029-1)',
    JSON.stringify(seeded).includes('choicePending') === false && seeded.sync === undefined,
    'the preferences reached the synchronised store');

  await waitFor(
    `/written/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'the status line never reported the write',
  );
  const writtenStatus = await textOf('#sync .sync-status');
  check('the status says written, and explicitly disclaims knowing more (A4, BR-029-6)',
    /written/i.test(writtenStatus) && /cannot see/i.test(writtenStatus) && !/up to date/i.test(writtenStatus),
    `status=${JSON.stringify(writtenStatus)}`);

  // ── Step 5, the other half: a change from "another device" ─────────────────
  // Written straight into `chrome.storage.sync` in the layout the reader
  // expects, which is exactly what a second browser's write looks like arriving.
  //
  // Cleared first, and the reason is worth keeping: a second device's engine
  // computes its own delta and prunes the shards its configuration no longer
  // fills, so what arrives is a *complete* layout and never a partial overwrite
  // of a larger one. Leaving this device's eleven-rule seed underneath produced
  // a store no real device would write — an eleven-rule `rules.1` under a
  // two-rule index — and this device then correctly tidied it, which is a
  // perfectly good behaviour arriving in the middle of the check for a
  // different one.
  await openGate();
  await clearSync();
  await inWorker(`chrome.storage.sync.set(${JSON.stringify({
    index: { version: 1, rules: 2, profiles: 1 },
    locale: THERE.locale,
    exclusions: THERE.exclusions,
    behaviour: THERE.behaviour,
    passwords: THERE.passwords,
    sources: THERE.sources,
    triggers: THERE.triggers,
    'rules.0': THERE.rules,
    'profiles.0': THERE.profiles,
  })}).then(() => true)`);

  await waitInWorker(
    `chrome.storage.local.get('settings').then((s) => (s.settings?.rules ?? []).length === 2)`,
    'a configuration arriving from another device was never adopted',
  );
  check('an arriving configuration replaces this device’s, through the single-replacement path (BR-029-2)',
    canonicalState(await stored()) === canonicalState(THERE),
    `stored=${canonicalState(await stored()).slice(0, 200)}`);

  await waitFor(
    `/arrived/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'the adoption was never reported on screen',
  );

  const ruleList = await textOf('#rules');
  check('and the page adopts it, so the rule list stops showing what is gone (A3, UC-024)',
    !ruleList.includes('Kundenstraße') && ruleList.includes('remote-a'),
    `#rules=${JSON.stringify(ruleList.slice(0, 160))}`);

  // ── BR-029-5 and readReplica: an incomplete replica is never applied ───────
  // The index says three shards and two are present. A reader that trusted the
  // key list would adopt a prefix of somebody's rule list as though it were the
  // list, with both browsers reporting success.
  await openGate();
  const before = canonicalState(await stored());
  await inWorker(`chrome.storage.sync.set(${JSON.stringify({
    index: { version: 1, rules: 24, profiles: 1 },
    'rules.0': Array.from({ length: 8 }, (_, n) => rule(`torn${n}`)),
    'rules.1': Array.from({ length: 8 }, (_, n) => rule(`torn1${n}`)),
  })}).then(() => true)`);
  await sleep(1200);

  check('a replica whose index names a shard that has not arrived is not applied (BR-029-5)',
    canonicalState(await stored()) === before,
    `stored changed to ${canonicalState(await stored()).slice(0, 200)}`);

  // ── A1: the ceiling stops, and never truncates ────────────────────────────
  // Past the total quota by a wide margin. What is being checked is not the
  // number — that is DD-002's spike — but the behaviour at it: local storage
  // keeps everything, the replica is marked not current, and the screen says
  // what stopped it and what would restore it.
  await clearSync();
  await openGate();
  const TOO_MANY = base(Array.from({ length: 900 }, (_, n) => rule(`bulk${n}`, {
    label: `Rule number ${n} with a label long enough to make this configuration a real one`,
  })));
  await seed(TOO_MANY);

  await waitFor(
    `/stopped/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'a configuration past the ceiling never reported that synchronisation had stopped',
  );

  check('nothing is truncated — local storage still holds every rule (BR-029-5)',
    (await stored()).rules.length === 900,
    `local rules=${(await stored()).rules.length}`);

  const stopped = await textOf('#sync .sync-status');
  check('the screen says it stopped, what stopped it, and what restores it (A1, FR-059)',
    /stopped/i.test(stopped) && stopped.includes('900') && /Remove some rules/i.test(stopped) &&
      /turn synchronisation off/i.test(stopped),
    `status=${JSON.stringify(stopped)}`);

  const marked = await replica();
  check('and the replica is marked not current, so no other device applies it (A1)',
    marked.index?.stopped === true,
    `index=${JSON.stringify(marked.index)}`);

  // ── A5: turning it off leaves the other devices alone ─────────────────────
  // The gate is opened *before* the seed, and the order is not incidental: a
  // settings change is what asks for a flush, and asking with the gate still
  // closed schedules one 72 s out — correct behaviour, and a harness waiting ten
  // seconds for it would call the product broken.
  await clearSync();
  await openGate();
  await seed(HERE);
  await openOptions();
  await waitInWorker(
    `chrome.storage.sync.get('index').then((s) => s.index !== undefined)`,
    'the replica was not rewritten after the configuration came back under the ceiling',
  );
  const carried = await replica();

  await clickWithGesture(cdp, page, '#sync .sync-view input[type="checkbox"]');
  await sleep(500);

  check('turning synchronisation off leaves the synchronised copy exactly as it was (A5)',
    JSON.stringify(await replica()) === JSON.stringify(carried),
    'the replica changed when the feature was switched off');
  check('and local storage stays complete and authoritative',
    canonicalState(await stored()) === canonicalState(HERE),
    `stored=${canonicalState(await stored()).slice(0, 200)}`);

  const off = await prefs();
  check('the preference is off and nothing is left queued',
    off?.enabled === false && off?.pending === false,
    `prefs=${JSON.stringify(off)}`);

  // ── Step 3: a store holding something different asks rather than overwrites ─
  // The replica still holds the eleven-rule configuration A5 left there — that
  // is A5's whole point — so putting a single rule on this device makes the two
  // sides genuinely different, which is the case step 3 exists for.
  await seed(base([rule('solo')]));
  await openGate();
  await openOptions();
  await clickWithGesture(cdp, page, '#sync .sync-view input[type="checkbox"]');
  await waitFor(
    `document.querySelector('#sync .sync-choice') !== null`,
    'a store holding a different configuration did not ask which one to keep (step 3)',
  );

  const sides = await textOf('#sync .sync-choice-summary');
  check('both sides are named in one sentence, in counts (step 3)',
    sides.includes('1 rule(s)') && sides.includes('11 rule(s)') && /replaces the other/i.test(sides),
    `sides=${JSON.stringify(sides)}`);

  check('the focus lands on a real choice rather than on the page body',
    (await inPage(`document.activeElement?.matches('.sync-keep-here') ?? false`)) === true,
    `focused=${JSON.stringify(String(await inPage(`document.activeElement?.className ?? String(document.activeElement)`)))}`);

  // Nothing may move in either direction while the question stands.
  const heldLocal = canonicalState(await stored());
  const heldReplica = JSON.stringify(await replica());
  await sleep(800);
  check('neither direction runs while the choice is unanswered',
    canonicalState(await stored()) === heldLocal && JSON.stringify(await replica()) === heldReplica,
    'something was written while step 3 was on screen');

  await clickWithGesture(cdp, page, '#sync .sync-take-there');
  await sleep(800);
  check('taking the synchronised configuration replaces this device’s (step 3)',
    (await stored()).rules.length === 11 && (await prefs())?.choicePending === false,
    `rules=${(await stored()).rules.length}, prefs=${JSON.stringify(await prefs())}`);

  // ── NFR-023: the gate actually holds a second change back ─────────────────
  // The *arithmetic* — two calls a flush, 72 s apart, 100 an hour — is asserted
  // against the shipped constant in `tests/sync.test.ts`, because a harness that
  // waited to observe it would take an hour and would still only have watched
  // one machine. What is worth watching here is the behaviour that arithmetic
  // rests on: a change made straight after a write does not produce a second
  // one. The gate is deliberately *not* wound back for this check.
  const editExclusion = async (pattern) =>
    inPage(`(() => {
      const input = document.querySelector('#field-exclusions [data-exclusion="0"] input[type="text"]')
        ?? document.querySelector('#field-exclusions input[type="text"]');
      if (input === null) return false;
      input.value = ${JSON.stringify(pattern)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  // A first edit, to close the gate. Taking the store's configuration wrote
  // nothing — the store already held it, which is what `unchanged` is for — so
  // the gate was still open and the check below would have been measuring
  // nothing. That is worth stating rather than silently ordering around: the
  // gate is about write *calls*, and an adoption makes none.
  check('the edit control the gate check needs is on the page', (await editExclusion('captcha')) === true,
    'no field-exclusion input to type into');
  // Waited on the replica rather than on the status line, and the difference
  // cost a run: the status still read "written" from an earlier step, so a wait
  // on that word matched before this edit had gone anywhere and the check below
  // measured the *first* write landing rather than the second being held. Wait
  // on the thing about to be measured.
  await waitInWorker(
    `chrome.storage.sync.get('exclusions').then((s) => s.exclusions?.fields?.[0]?.pattern === 'captcha')`,
    'the first edit was never written, so the gate was never closed',
  );

  const writtenReplica = await replica();
  await editExclusion('captcha-again');
  await sleep(1500);

  const afterEdit = await replica();
  const moved = [...new Set([...Object.keys(writtenReplica), ...Object.keys(afterEdit)])].filter(
    (key) => JSON.stringify(writtenReplica[key]) !== JSON.stringify(afterEdit[key]),
  );
  check('a change made straight after a write is held back rather than written (NFR-023)',
    moved.length === 0,
    `the replica was rewritten inside the rate gate: ${JSON.stringify(moved)} — ` +
      `${JSON.stringify(moved.map((k) => [writtenReplica[k], afterEdit[k]])).slice(0, 300)}`);

  const queued = await textOf('#sync .sync-status');
  check('and the screen says it is queued without promising when it will go (BR-029-6)',
    /queued/i.test(queued) && /has not gone yet/i.test(queued) && !/shortly/i.test(queued),
    `status=${JSON.stringify(queued)}`);

  // ── The two failure paths, injected ───────────────────────────────────────
  // Both were review findings on 2026-08-28, and both were about a *sentence*
  // naming the wrong subject — the one class of defect a unit test can confirm
  // the fix of and never confirm the presence of, because what is wrong is what
  // the user is told. They are induced by patching the storage API inside the
  // worker, which is the only place either failure can be made to happen on
  // demand.
  //
  // **Every attempt re-establishes its own preconditions, and that is not
  // defensive dressing.** The patch lives in an MV3 service worker, which the
  // browser may stop at any moment; when it does, the patch goes with it and the
  // operation under test quietly succeeds — so the first version of this block
  // failed about one run in three, which in CI is worse than not testing it at
  // all. The fault is therefore re-installed per attempt, its survival is
  // checked *during* the wait rather than only before it, and a wait that ends
  // because the fault died is a retry rather than a failure.

  /** Whether the injected fault is still installed. A stopped worker takes it with it. */
  const faultAlive = async () => (await inWorker(`globalThis.__ffFault === true`)) === true;

  /**
   * `waitInWorker` without the throw — the shape a *precondition* needs.
   *
   * Setting a fault check up means driving the engine, and driving the engine
   * from outside its own queue is timing-dependent by nature: a settings change
   * is handled in a service worker the browser may stop, so the write it
   * provokes sometimes has not landed when the check is ready for it. Throwing
   * there ended the run over a setup step, and worse, it did so *past* the retry
   * loop built for exactly this. Returning false instead makes an unready
   * precondition what it actually is — this attempt did not get started — and
   * the next attempt provokes it again with a fresh value.
   */
  const pollWorker = async (expression, tries = 60) => {
    for (let waited = 0; waited < tries; waited++) {
      if ((await inWorker(expression)) === true) return true;
      await sleep(200);
    }
    return false;
  };

  const clearFault = async () =>
    inWorker(`(() => {
      if (globalThis.__ffRestore) { globalThis.__ffRestore(); delete globalThis.__ffRestore; }
      delete globalThis.__ffFault;
      return true;
    })()`);

  /**
   * Installs a fault, provokes it, and waits for the screen to say so — retrying
   * the whole cycle if the worker was stopped somewhere in the middle.
   */
  const underFault = async (install, provoke, ready, whatFailed) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await clearFault();
      // A precondition that did not come up is a retry, not a failure: the
      // engine runs in a worker the browser may stop, so "the write has not
      // landed yet" and "the write will never land" look identical from here
      // until another change provokes one.
      if ((await provoke.before?.(attempt)) === false) continue;
      await inWorker(install);
      if (!(await faultAlive())) continue;
      await provoke.trigger(attempt);

      for (let waited = 0; waited < 100; waited++) {
        if ((await inPage(ready)) === true) return;
        if (!(await faultAlive())) break;
        await sleep(100);
      }
    }
    throw new Error(whatFailed);
  };

  // 1. A synchronised read that fails is not an empty store.
  //    The assertion that matters is not the sentence — it is that the replica
  //    is untouched. Read as empty, the delta contains every key and the flush
  //    rewrites the whole configuration, which is the exact whole-configuration
  //    last-writer-wins write the sharded delta exists to prevent.
  let beforeFault = JSON.stringify(await replica());
  await underFault(
    `(() => {
      const real = chrome.storage.sync.get;
      globalThis.__ffRestore = () => { chrome.storage.sync.get = real; };
      globalThis.__ffFault = true;
      chrome.storage.sync.get = () => Promise.reject(new Error('injected: read failed'));
      return true;
    })()`,
    {
      before: async () => {
        beforeFault = JSON.stringify(await replica());
        return true;
      },
      trigger: async (attempt) => { await editExclusion(`read-fault-${attempt}`); },
    },
    `/could not be read/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'a failed read of the synchronised store was never reported',
  );

  const unreadable = await textOf('#sync .sync-status');
  check('a failed read says the store could not be read, not that a write was refused',
    /could not be read/i.test(unreadable) && !/refused/i.test(unreadable) &&
      /unaffected|nothing was written/i.test(unreadable),
    `status=${JSON.stringify(unreadable)}`);

  await clearFault();
  check('and nothing was written to the replica while the store could not be read',
    JSON.stringify(await replica()) === beforeFault,
    'a failed read seeded the store — the delta was computed against an empty one');

  // The stale-sentence half: a read failure must not outlive the failure.
  await openGate();
  await editExclusion('read-recovered');
  await waitFor(
    `/written/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'the read-failure sentence outlived the failure',
  );

  // 2. A local write that fails is not the synchronised store refusing anything.
  //    Only writes carrying `settings` are rejected, so the preferences this
  //    path has to record still land — which is what makes the failure
  //    reportable at all. Each attempt first pushes a fresh configuration with
  //    the fault *off*, because an adoption is only planned when this device and
  //    the store are known to agree, and that agreement is what a lost fault in
  //    a previous attempt would have destroyed.
  await underFault(
    `(() => {
      const real = chrome.storage.local.set.bind(chrome.storage.local);
      globalThis.__ffRestore = () => { chrome.storage.local.set = real; };
      globalThis.__ffFault = true;
      chrome.storage.local.set = (items, ...rest) =>
        items && Object.prototype.hasOwnProperty.call(items, 'settings')
          ? Promise.reject(new Error('injected: local write failed'))
          : real(items, ...rest);
      return true;
    })()`,
    {
      before: async (attempt) => {
        // No `clearSync` here, and its absence is the point. Clearing the store
        // from the harness is a write that does not go through the engine's own
        // queue, so it can land between a flush's read and that flush's write —
        // which is exactly what happened: the engine wrote a one-key delta
        // computed against a store the harness had emptied a moment earlier, and
        // the re-seed this step waits for never came. It is also unnecessary. A
        // complete layout arriving over a larger one is still complete, because
        // `readReplica` reads the index rather than the key list and ignores the
        // shards it does not name.
        //
        // What this does need is agreement: an arrival is only planned when
        // local and the store are known to match, so the attempt makes that true
        // by letting a real write happen, and waits on the *replica* rather than
        // on a status word — a status can still be reading `written` from an
        // earlier step, which has cost this harness a run before.
        await openGate();
        await editExclusion(`local-fault-${attempt}`);
        return pollWorker(
          `chrome.storage.sync.get('exclusions').then((s) => s.exclusions?.fields?.[0]?.pattern === 'local-fault-${attempt}')`,
        );
      },
      trigger: async () => {
        await inWorker(`chrome.storage.sync.set(${JSON.stringify({
          index: { version: 1, rules: 2, profiles: 1 },
          locale: THERE.locale,
          exclusions: THERE.exclusions,
          behaviour: THERE.behaviour,
          passwords: THERE.passwords,
          sources: THERE.sources,
          triggers: THERE.triggers,
          'rules.0': THERE.rules,
          'profiles.0': THERE.profiles,
        })}).then(() => true)`);
      },
    },
    `/could not be saved/i.test(document.querySelector('#sync .sync-status')?.textContent ?? '')`,
    'a local write failing while adopting an arrival was never reported as itself',
  );

  const unsaved = await textOf('#sync .sync-status');
  check('a failed local write names this browser, not the synchronised store (NFR-020)',
    /could not be saved on this browser/i.test(unsaved) &&
      !/Synchronised storage refused/i.test(unsaved) && /unchanged/i.test(unsaved),
    `status=${JSON.stringify(unsaved)}`);

  await clearFault();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}

console.log('\n  UC-029 — a configuration through the browser’s own synchronised storage\n');
for (const { name, ok, detail } of checks) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${detail}`}`);
}

if (failures.length > 0) {
  console.error('\n✖ sync end-to-end failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\n✔ a configuration is written sharded, arrives as one replacement, and stops rather than truncates\n');
