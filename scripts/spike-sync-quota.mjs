#!/usr/bin/env node
/**
 * The sizing exercise DD-002 asks for: does a real configuration fit in
 * `storage.sync`, and if not, at what size does it stop fitting?
 *
 * DD-002 has been open since 2026-08-12 with three candidate layouts — shard the
 * rules, compress, or keep the bulk in `storage.local` behind a synced manifest
 * — and no numbers to choose between them. It also names a second half that is
 * not about bytes at all: synchronised storage is last-writer-wins *per key*, so
 * whatever the layout turns out to be, it decides how much of a configuration
 * two devices can silently destroy between them. Both halves are reported here.
 *
 * Nothing is asserted from the documented quota constants. They are read off
 * `chrome.storage.sync` in the running browser, every layout is *written* to
 * sync storage rather than compared against a number, and each layout's ceiling
 * is found by bisecting the rule count until the write actually fails. A
 * prediction and an observation are printed side by side; where they disagree,
 * the observation is the answer.
 *
 * Two probes run before any of that, because the whole run is worthless if
 * either is wrong:
 *
 *   · the **control probe** writes an item that must not fit. A signed-out
 *     Chromium keeps sync data locally, and a build that did not enforce the
 *     quota would let every layout through and this spike would report a
 *     comfortable pass meaning nothing. If the oversized write succeeds, the run
 *     fails instead of reporting.
 *   · the **accounting probe** settles what a "byte" is here, which the docs
 *     leave ambiguous and which matters to exactly the users the corpus serves:
 *     `Kundenstraße` is 12 UTF-16 code units and 13 UTF-8 bytes, and a de-CH
 *     configuration is full of them. It writes a value that fits under one
 *     accounting and not under the other, and reports which one the browser
 *     kept.
 *
 * **Extended 2026-08-28 with the other store's ceiling.** `storage.sync` is where
 * a configuration stops travelling; `storage.local` is where it stops existing,
 * and FR-044 ("no cap on the number of rules") had no measurement behind it at
 * all. The same fixture and the same bisection answer both, which is the only
 * way the two numbers can be quoted in one sentence — the search runs inside the
 * worker, because at this store's scale shipping each candidate over CDP is not
 * a thing worth doing.
 *
 * What this does not measure: Firefox. Its documented constants match Chrome's,
 * but no harness here can reach an installed add-on's storage — `smoke-firefox`
 * proves the add-on installs and `e2e-firefox` runs the engine with no extension
 * at all — so every number below is Chromium's, observed rather than assumed
 * only there.
 *
 * Usage: pnpm run build && node scripts/spike-sync-quota.mjs
 *   CHROME_PATH=…  override the browser binary
 *   RULES=…        rules in the fixture configuration (default 100, DD-002's number)
 *   HEADFUL=1      show the window
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachToWorker, closeChromium, derivedExtensionId, launchChromium, sleep } from './lib/chromium.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const RULES = Number(process.env['RULES'] ?? 100);
/**
 * Shard sizes to measure alongside the greedy one, smallest blast radius last.
 *
 * DD-002 chose sharding on 2026-08-19 and inherited 35 rules a shard with it —
 * which is not a number anyone picked. It is however many rules fit in an 8 KB
 * item, and it became the blast radius by default. Since L3's ceiling is the
 * *total* quota rather than the per-item one, a smaller shard may cost nothing
 * that matters; the point of these rows is that `may` is not an argument worth
 * having when the spike can write them.
 */
const SHARD_CAPS = [16, 8, 4];

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Chromium build found. Run `pnpm run build` first.');
  process.exit(1);
}

/* ------------------------------------------------------------------ fixture */

/**
 * A configuration someone would actually have, at the size DD-002 names.
 *
 * Deterministic — no clock and no randomness — so two runs of this spike produce
 * the same bytes and a change in the numbers means a change in the schema.
 *
 * The shapes are cycled rather than uniform because rule size is what the whole
 * exercise turns on and a rule is not one size. A `list` generator carrying its
 * options is several times the size of `{"type":"email"}`, an explicit `sources`
 * array adds an array of strings to a rule that would otherwise inherit, and a
 * rule's UUID costs 47 bytes before anything the user wrote. A fixture of
 * `email` rules would report a per-rule cost no real configuration reproduces.
 *
 * Two labels are deliberately non-ASCII. A de-CH user is one of the two locales
 * this project ships (DD-001's corpus note), their rules are named in German,
 * and if the browser counts UTF-8 bytes then those labels cost more than they
 * look — which is the difference the accounting probe exists to settle.
 */
const LABELS = [
  'Login e-mail',
  'Kundenstraße',
  'Staging password',
  'Billing postcode',
  'Order reference',
  'Contact telephone',
  'Company name',
  'Delivery date',
  'Grösse in cm',
  'Notes field',
];

const PATTERNS = [
  'user_email',
  'billing_postcode',
  'shipping_address_line_1',
  'account[first_name]',
  'customer.telephone',
  'order_ref',
  'company',
  'delivery_date',
  'notes',
  'confirm_password',
];

/** The generator variants a real list mixes, cycled in order. */
function generatorFor(index) {
  switch (index % 8) {
    case 0:
      return { type: 'email' };
    case 1:
      return { type: 'name', part: 'first' };
    case 2:
      return { type: 'alphanumeric', template: 'ORD-{digit:6}-{alpha:2}' };
    case 3:
      return { type: 'regex', pattern: '(CH|DE|AT)-[0-9]{4}-[A-Z]{3}' };
    case 4:
      return { type: 'date', format: 'DD.MM.YYYY', from: '1970-01-01', to: '2005-12-31' };
    case 5:
      return {
        type: 'list',
        items: ['Herr', 'Frau', 'Divers', 'Mr', 'Mrs', 'Ms', 'Mx', 'Dr'],
      };
    case 6:
      return { type: 'number', min: 1, max: 9999, decimals: 0 };
    default:
      return { type: 'text', minWords: 4, maxWords: 12 };
  }
}

/**
 * UUIDs, because that is what the editor mints (`options/rules.ts`) and 47 bytes
 * per rule of identifier is part of the answer rather than an artefact of the
 * fixture. Generated from the index so the fixture stays reproducible.
 */
function ruleId(prefix, index) {
  const hex = (n, width) => n.toString(16).padStart(width, '0');
  return `${hex(index, 8)}-1f2e-4c3d-8a9b-${prefix}${hex(index, 6)}`;
}

function seedRules(count, prefix = 'aa77bb') {
  return Array.from({ length: count }, (_, index) => ({
    id: ruleId(prefix, index),
    label: `${LABELS[index % LABELS.length]} ${index}`,
    enabled: index % 11 !== 0,
    match: {
      mode: index % 5 === 0 ? 'regex' : index % 3 === 0 ? 'exact' : 'contains',
      pattern: index % 5 === 0 ? `^${PATTERNS[index % PATTERNS.length]}[0-9]*$` : PATTERNS[index % PATTERNS.length],
    },
    // Most rules inherit the global sources; about one in seven narrows them,
    // which is the proportion the editor's own default invites (FR-067).
    ...(index % 7 === 0 ? { sources: ['name', 'id', 'label'] } : {}),
    generator: generatorFor(index),
    fromPersona: index % 4 !== 0,
  }));
}

/**
 * Four profiles with their own rules — the Phase 5 shape, and the reason a
 * "100-rule configuration" is not 100 rules. A Power User with four applications
 * has a global list *and* a per-application list, and `profiles` is one key.
 */
function seedProfiles() {
  return ['staging', 'qa', 'localhost', 'partner-portal'].map((name, index) => ({
    id: ruleId('cc88dd', index),
    label: `${name} environment`,
    enabled: true,
    urls: [`*://*.${name}.example.com/*`, `*://${name}.internal/*`, `*://localhost:${8000 + index}/*`],
    rules: seedRules(8, `dd99ee${index}`),
  }));
}

function seedSettings(ruleCount) {
  return {
    version: 1,
    locale: 'auto',
    rules: seedRules(ruleCount),
    profiles: seedProfiles(),
    exclusions: {
      fields: [
        { mode: 'contains', pattern: 'captcha' },
        { mode: 'contains', pattern: 'coupon' },
        { mode: 'exact', pattern: 'csrf_token' },
        { mode: 'regex', pattern: '^(otp|mfa|totp)' },
        { mode: 'contains', pattern: 'search' },
        { mode: 'contains', pattern: 'newsletter' },
      ],
      domains: [
        'bank.example.com',
        '*.gov.uk',
        'admin.internal',
        'mail.example.com',
        '*.payments.example.net',
        'intranet.example.ch',
      ],
    },
    behaviour: {
      dispatchEvents: true,
      skipHidden: true,
      skipPreFilled: true,
      maxLengths: { text: 64, textarea: 200, email: 48 },
      // The shipped keyword lists, which a user who never opened the screen
      // still stores: defaults are persisted state, not absence (DD-005).
      consentKeywords: ['terms', 'privacy', 'agree', 'accept', 'consent', 'gdpr', 'einwilligung', 'zustimmen'],
      confirmationKeywords: ['confirm', 'repeat', 'again', 'verify', 'wiederholen', 'bestätigen'],
    },
    passwords: { length: 20, upper: true, lower: true, digits: true, symbols: true },
    sources: { name: true, id: true, testId: true, className: false, label: true, placeholder: true, ariaLabel: true },
    triggers: { contextMenu: true },
  };
}

/* ------------------------------------------------------------------ layouts */

/**
 * The candidates DD-002 names, each as the `{key: value}` object a save would
 * write. What separates them is not only size: `items` is how many keys a save
 * touches, and `blastRadius` is what one lost key costs, which is the
 * conflict half of the decision.
 */
function layouts(settings, perItemLimit) {
  const { rules, profiles, ...rest } = settings;

  /**
   * Greedy packing: entries go into a shard until the next one would not fit —
   * or until `cap` of them are in it, whichever comes first.
   *
   * The cap is what the second half of DD-002 turns on, and it is why this
   * takes a parameter at all. Packing to the per-item quota fits the *most*
   * rules in a key; it says nothing about how much a conflict should destroy.
   * A shard is the unit last-writer-wins throws away, so the cap sets the blast
   * radius directly — and what a smaller one costs is measured below rather
   * than reasoned about, because more shards means more keys and every key's
   * name counts against the total quota that L3's ceiling lands on.
   */
  const shard = (list, keyOf, cap = Infinity) => {
    const shards = [];
    let current = [];
    for (const entry of list) {
      const next = [...current, entry];
      const full = current.length >= cap || size(keyOf(shards.length), next) > perItemLimit;
      if (current.length > 0 && full) {
        shards.push(current);
        current = [entry];
      } else {
        current = next;
      }
    }
    if (current.length > 0) shards.push(current);
    return shards;
  };

  /** One L3 layout at a given shard cap; `Infinity` is the original greedy one. */
  const shardedAt = (cap) => {
    const ruleShards = shard(rules, (n) => `rules.${n}`, cap);
    const profileShards = shard(profiles, (n) => `profiles.${n}`, cap);
    const worstShard = Math.max(0, ...ruleShards.map((s) => s.length));
    return {
      name: cap === Infinity ? 'L3 · sharded rules and profiles' : `L3/${cap} · sharded, ${cap} per shard`,
      note:
        `rules packed into ${ruleShards.length} shard(s), profiles into ${profileShards.length}` +
        (cap === Infinity ? ' — packed to the item quota, no cap' : ` — capped at ${cap} rules a shard`),
      blastRadius: `up to ${worstShard} rules`,
      items: {
        ...rest,
        index: { rules: ruleShards.length, profiles: profileShards.length },
        ...Object.fromEntries(ruleShards.map((s, n) => [`rules.${n}`, s])),
        ...Object.fromEntries(profileShards.map((s, n) => [`profiles.${n}`, s])),
      },
    };
  };

  return [
    {
      name: 'L1 · one item',
      note: 'the reference’s layout — everything under one key',
      blastRadius: 'the whole configuration',
      items: { settings },
    },
    {
      name: 'L2 · one item per section',
      note: 'the DD-005 storage shape, lifted key for key',
      blastRadius: 'every rule, or every profile',
      items: { ...rest, rules, profiles },
    },
    shardedAt(Infinity),
    ...SHARD_CAPS.map(shardedAt),
    {
      // The conflict half taken seriously: if a lost key should cost one rule
      // rather than a shard of them, the shard has to be one rule. Ordering then
      // needs a key of its own — first match wins (FR-031), so the order is
      // state, not presentation — and that key is the one this layout has to be
      // watched for: it grows by one UUID per rule and is itself subject to the
      // per-item quota.
      name: 'L5 · one item per rule',
      note: `${rules.length} rule items, ${profiles.length} profile items, one order list`,
      blastRadius: 'one rule — or the whole ordering, if the order key is the one lost',
      items: {
        ...rest,
        order: rules.map((rule) => rule.id),
        ...Object.fromEntries(rules.map((rule) => [`rule.${rule.id}`, rule])),
        ...Object.fromEntries(profiles.map((profile) => [`profile.${profile.id}`, profile])),
      },
    },
    {
      name: 'L4 · manifest only, bulk in local',
      note: 'syncs a pointer; the configuration itself never leaves the device',
      blastRadius: 'nothing — and nothing is carried either',
      items: { manifest: { version: 1, rules: rules.length, profiles: profiles.length, written: 0 } },
    },
  ];
}

/* ------------------------------------------------------------------- sizing */

/**
 * Chrome documents an item's size as the JSON stringification of its value plus
 * the length of its key. Both readings of "length" are computed; the accounting
 * probe decides which one is used for the predictions.
 */
const utf16 = (key, value) => key.length + JSON.stringify(value).length;
const utf8 = (key, value) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
let size = utf16;

const total = (items) => Object.entries(items).reduce((sum, [key, value]) => sum + size(key, value), 0);
const largest = (items) =>
  Object.entries(items).reduce(
    (worst, [key, value]) => (size(key, value) > worst.bytes ? { key, bytes: size(key, value) } : worst),
    { key: '—', bytes: 0 },
  );

/* --------------------------------------------------------------------- main */

const extensionId = derivedExtensionId(EXTENSION_DIR);
const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-sync-'));
let chrome;
let cdp;

try {
  ({ chrome, cdp } = await launchChromium(EXTENSION_DIR, profileDir));
  const worker = await attachToWorker(cdp, extensionId);

  const inWorker = async (expression) => {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      worker,
    );
    return result.value;
  };

  /**
   * A write, reported rather than thrown.
   *
   * The rate limits are a different failure from the size limits and must not be
   * read as one: `MAX_WRITE_OPERATIONS_PER_MINUTE` is 120 and a bisection spends
   * writes freely, so a run that ignored the difference would find its "ceiling"
   * wherever it happened to run out of write budget. A rate-limited write waits
   * and is retried; only a quota-by-size failure counts as not fitting.
   */
  const writeSync = async (items) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await inWorker(`(async () => {
        try {
          await chrome.storage.sync.clear();
          await chrome.storage.sync.set(${JSON.stringify(items)});
          return { ok: true };
        } catch (error) {
          return { ok: false, message: String(error && error.message ? error.message : error) };
        }
      })()`);
      if (outcome.ok) return outcome;
      if (!/WRITE_OPERATIONS/i.test(outcome.message)) return outcome;
      // Long enough that eight of them outlast a full minute window. A bisection
      // that gave up sooner would record "did not fit" for a write refused on
      // rate rather than on size, and the ceiling it reported would be an
      // artefact of how fast this harness happens to run.
      await sleep(10_000);
    }
    return { ok: false, rateLimited: true, message: 'write-rate limited on every attempt' };
  };

  // ── The quota constants, read off the browser ──────────────────────────────
  const quota = await inWorker(`({
    perItem: chrome.storage.sync.QUOTA_BYTES_PER_ITEM,
    totalBytes: chrome.storage.sync.QUOTA_BYTES,
    maxItems: chrome.storage.sync.MAX_ITEMS,
    perHour: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_HOUR,
    perMinute: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE,
  })`);

  console.log('\n  DD-002 — storage.sync sizing, measured in Chromium\n');
  console.log(`  Quota, as the browser reports it: ${quota.perItem} bytes per item, ${quota.totalBytes} total,`);
  console.log(`  ${quota.maxItems} items, ${quota.perMinute} writes/minute and ${quota.perHour} writes/hour.\n`);

  // ── Control probe: enforcement must be observable ──────────────────────────
  const oversized = await writeSync({ control: 'x'.repeat(quota.perItem * 2) });
  if (oversized.ok) {
    console.error(
      `✖ an item of ${quota.perItem * 2} bytes was accepted — this browser is not enforcing the\n` +
        '  per-item quota, so nothing below would mean anything. Refusing to report numbers.\n',
    );
    process.exitCode = 1;
    throw new Error('sync quota not enforced');
  }
  console.log(`  ✔ control probe — an oversized item is refused: ${oversized.message}`);

  // ── Accounting probe: UTF-16 code units, or UTF-8 bytes? ───────────────────
  // A euro sign is one UTF-16 code unit and three UTF-8 bytes. `fits16` is under
  // the limit counted one way and three times over it counted the other, so
  // whether it writes names the accounting.
  const fits16 = await writeSync({ probe: '€'.repeat(Math.floor((quota.perItem - 64) / 2)) });
  size = fits16.ok ? utf16 : utf8;
  console.log(
    `  ✔ accounting probe — the browser counts ${fits16.ok ? 'UTF-16 code units' : 'UTF-8 bytes'}` +
      `${fits16.ok ? '' : `: ${fits16.message}`}`,
  );
  console.log(`    (it matters for de-CH labels: “Kundenstraße” is 12 units and 13 bytes.)\n`);

  // ── The fixture ────────────────────────────────────────────────────────────
  const settings = seedSettings(RULES);
  const whole = size('settings', settings);
  const bare = size('settings', seedSettings(0));
  console.log(`  A ${RULES}-rule configuration — ${settings.profiles.length} profiles carrying ` +
    `${settings.profiles.reduce((n, p) => n + p.rules.length, 0)} rules of their own,\n` +
    `  ${settings.exclusions.domains.length} excluded domains, both keyword lists — serialises to ` +
    `${whole} bytes.\n`);
  console.log(`  Of that, ${bare} bytes is everything except the global rule list, and the list itself`);
  console.log(`  averages ${((whole - bare) / RULES).toFixed(1)} bytes per rule (36 of them the UUID the editor mints).\n`);

  // ── Each layout, written for real ──────────────────────────────────────────
  const rows = [];
  for (const layout of layouts(settings, quota.perItem)) {
    const worst = largest(layout.items);
    const bytes = total(layout.items);
    const count = Object.keys(layout.items).length;
    const predicted = worst.bytes <= quota.perItem && bytes <= quota.totalBytes && count <= quota.maxItems;
    const observed = await writeSync(layout.items);
    rows.push({ layout, worst, bytes, count, predicted, observed });
  }

  console.log('  Layout                              items   largest item      total   predicted   written\n');
  for (const row of rows) {
    const mark = row.observed.ok ? '✔' : '✖';
    console.log(
      `  ${mark} ${row.layout.name.padEnd(33)} ${String(row.count).padStart(4)}   ` +
        `${String(row.worst.bytes).padStart(6)} B   ${String(row.bytes).padStart(7)} B   ` +
        `${(row.predicted ? 'fits' : 'over').padStart(9)}   ${row.observed.ok ? 'yes' : 'no'}`,
    );
    console.log(`      ${row.layout.note}`);
    console.log(`      a lost key costs: ${row.layout.blastRadius}`);
    if (!row.observed.ok) console.log(`      refused: ${row.observed.message}`);
    if (row.predicted !== row.observed.ok) {
      console.log('      ⚠ prediction and observation disagree — the observation is the answer');
    }
    console.log('');
  }

  // ── Where each layout stops fitting ────────────────────────────────────────
  // Bisected against real writes rather than divided out of the average, because
  // the average hides the spread: sharding packs greedily, so its ceiling moves
  // in steps of a whole shard, and which quota it lands on — bytes, or items —
  // is not something the average can tell you. The failing write's own message
  // names the limit that stopped it.
  const itemsFor = (name, config) => layouts(config, quota.perItem).find((l) => l.name === name).items;

  const ceiling = async (name, make, high = 4096) => {
    const atZero = await writeSync(itemsFor(name, make(0)));
    if (atZero.rateLimited) throw new Error('the write-rate limit outlasted the backoff — no ceiling was measured');
    if (!atZero.ok) return { max: -1, reason: atZero.message };
    let low = 0;
    let reason = `no write failed below ${high} rules`;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const attempt = await writeSync(itemsFor(name, make(mid)));
      if (attempt.rateLimited) throw new Error('the write-rate limit outlasted the backoff — no ceiling was measured');
      if (attempt.ok) {
        low = mid;
      } else {
        high = mid - 1;
        reason = attempt.message;
      }
    }
    return { max: low, reason };
  };

  const withProfiles = (count) => seedSettings(count);
  const withoutProfiles = (count) => ({ ...seedSettings(count), profiles: [] });

  console.log('  Ceilings, bisected against real writes:\n');
  for (const [name, make, shape] of [
    ['L1 · one item', withProfiles, 'with the four profiles'],
    ['L1 · one item', withoutProfiles, 'with no profiles at all'],
    ['L2 · one item per section', withProfiles, 'with the four profiles'],
    ['L2 · one item per section', withoutProfiles, 'with no profiles at all'],
    ['L3 · sharded rules and profiles', withProfiles, 'with the four profiles'],
    ...SHARD_CAPS.map((cap) => [`L3/${cap} · sharded, ${cap} per shard`, withProfiles, `blast radius ${cap} rules`]),
    ['L5 · one item per rule', withProfiles, 'with the four profiles'],
  ]) {
    // 1024 for the capped rows rather than the default 4096: the greedy L3
    // ceiling is the total quota, which a cap can only lower, so a bound above
    // it is enough and each row it saves is four real writes against a rate
    // limit this run is already spending. A cap that somehow beat it would
    // report "no write failed below 1024", which is still an answer.
    const { max, reason } = await ceiling(name, make, name.startsWith('L3/') ? 1024 : 4096);
    const held =
      max < 0
        ? `does not fit with an empty rule list (${size('settings', make(0))} B of fixed sections)`
        : `holds ${max} global rules`;
    console.log(`  · ${name.padEnd(33)} ${shape.padEnd(24)} ${held}`);
    console.log(`      stopped by: ${reason}`);
  }
  console.log('');

  // ── The other store's ceiling, which is the one FR-044 is about ────────────
  // `storage.sync` is where a configuration stops travelling; `storage.local` is
  // where it stops *existing*, and until 2026-08-28 that number was nowhere —
  // FR-044 promised an uncapped rule list and no measurement said what the
  // platform would actually hold. Measured here rather than in a spike of its
  // own because the fixture, the bisection and the browser are already here, and
  // a per-rule cost measured against one store and quoted about the other is the
  // kind of borrowed number this file exists to stop.
  //
  // The whole search runs inside the worker. The sync bisection above ships each
  // candidate over CDP, which is fine at 401 rules and absurd at the tens of
  // thousands this ceiling turns out to sit at — so the fixture builders are sent
  // once, as their own source, and the loop runs where the storage API is. Their
  // source rather than a second copy of them: a fixture that drifted from the one
  // above would make the two ceilings incomparable, which is the only reason to
  // report them together.
  const fixtureSource = [
    `const LABELS = ${JSON.stringify(LABELS)};`,
    `const PATTERNS = ${JSON.stringify(PATTERNS)};`,
    generatorFor.toString(),
    ruleId.toString(),
    seedRules.toString(),
    seedProfiles.toString(),
    seedSettings.toString(),
  ].join('\n');

  const localQuota = await inWorker('chrome.storage.local.QUOTA_BYTES ?? null');
  const localCeiling = await inWorker(`(async () => {
    ${fixtureSource}
    const write = async (value) => {
      try {
        await chrome.storage.local.set({ probe: value });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) };
      }
    };

    // The control probe again, in this store's own terms: if an item twice the
    // reported quota is accepted, this browser is not enforcing it and the
    // bisection below would run to its bound and report a bound.
    const guard = await write('x'.repeat((chrome.storage.local.QUOTA_BYTES ?? 0) * 2 || 32 * 1024 * 1024));
    if (guard.ok) {
      await chrome.storage.local.remove('probe');
      return { enforced: false };
    }

    let low = 0;
    // Doubled from a number the sync ceilings make plausible rather than from
    // one that would build a 60 MB fixture on its first attempt.
    let high = 4096;
    let reason = 'no write failed below ' + high + ' rules';
    // Doubling first, so the bound is found rather than assumed. A fixed upper
    // bound that happened to fit would report itself as the ceiling.
    while (true) {
      const attempt = await write(seedSettings(high));
      if (!attempt.ok) { reason = attempt.message; break; }
      low = high;
      if (high >= 1048576) return { enforced: true, max: low, reason: 'no write failed below ' + high + ' rules' };
      high *= 2;
    }
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const attempt = await write(seedSettings(mid));
      if (attempt.ok) low = mid;
      else { high = mid - 1; reason = attempt.message; }
    }
    const bytes = JSON.stringify(seedSettings(low)).length;
    await chrome.storage.local.remove('probe');
    return { enforced: true, max: low, reason, bytes };
  })()`);

  console.log('  And the store the configuration actually lives in (FR-044):\n');
  if (!localCeiling.enforced) {
    console.log('  ⚠ storage.local accepted an item twice its reported quota, so this browser is not');
    console.log('    enforcing it and no ceiling was measured. The number is absent, not large.\n');
  } else {
    console.log(
      `  · storage.local ${'(the whole configuration, one item)'.padEnd(38)} holds ${localCeiling.max} global rules`,
    );
    console.log(`      stopped by: ${localCeiling.reason}`);
    console.log(
      `      ${localCeiling.bytes} B of a reported ${localQuota ?? 'unreported'} B quota` +
        `, ${(localCeiling.bytes / Math.max(1, localCeiling.max)).toFixed(0)} B a rule`,
    );
    console.log('');
  }

  // ── What a save costs against the write-rate limits ────────────────────────
  // The other half of sharding's price, and the one a byte count cannot answer:
  // if a write operation is counted per *key*, then L3's thirteen items cost
  // thirteen of the 120 a minute allows and a user editing rules quickly is
  // throttled by the layout rather than by their own typing. If it is counted
  // per *call*, sharding is free here. Bursting single-key and multi-key writes
  // until the limit answers it; the minute window is given time to clear first,
  // and it runs last because it deliberately exhausts that budget.
  const burst = async (keysPerCall, cap = 200) => {
    // Against an empty store, always. The first run of this burst inherited the
    // 401-rule configuration the ceiling search had just left behind and failed
    // on `kQuotaBytes` instead of on the rate limit — a rate measurement that was
    // really a leftover-bytes measurement, and it read as a plausible number
    // rather than as an error.
    await inWorker('chrome.storage.sync.clear().then(() => true, () => false)');
    let calls = 0;
    for (; calls < cap; calls++) {
      const items = Object.fromEntries(
        Array.from({ length: keysPerCall }, (_, k) => [`burst.${k}`, `${calls}`]),
      );
      const outcome = await inWorker(`(async () => {
        try {
          await chrome.storage.sync.set(${JSON.stringify(items)});
          return { ok: true };
        } catch (error) {
          return { ok: false, message: String(error && error.message ? error.message : error) };
        }
      })()`);
      if (!outcome.ok) return { calls, message: outcome.message };
    }
    return { calls, message: `no failure in ${cap} calls` };
  };

  console.log('  Write-rate accounting (the minute window is cleared before each burst):\n');
  await sleep(65_000);
  const single = await burst(1);
  await sleep(65_000);
  const multi = await burst(13);
  console.log(`  · one key per call    — ${single.calls} calls before the limit (${single.message})`);
  console.log(`  · thirteen per call   — ${multi.calls} calls before the limit (${multi.message})`);
  const onRate = [single, multi].every((b) => /WRITE_OPERATIONS/i.test(b.message));
  if (!onRate) {
    console.log('\n  ⚠ a burst ended on something other than the rate limit, so this says nothing');
    console.log('    about how write operations are counted. The number above is not an answer.\n');
  } else {
    const perKey = multi.calls > 0 && single.calls / multi.calls > 4;
    console.log(
      `\n  A write operation is counted per ${perKey ? 'key' : 'call'}, so L3's thirteen items cost ` +
        `${perKey ? 'thirteen' : 'one'} of the ${quota.perMinute} a minute allows.\n`,
    );
  }

  // Tidying up, and allowed to fail: the bursts above just spent the minute's
  // write budget on purpose, and a refused `clear` at this point is the limit
  // working rather than the run going wrong.
  await inWorker('chrome.storage.sync.clear().then(() => true, () => false)');
} catch (error) {
  console.error(`\n✖ sync-quota spike failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await closeChromium({ chrome, cdp, profileDir });
}
