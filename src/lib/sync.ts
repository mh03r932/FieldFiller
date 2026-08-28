import { parseSettings, type Settings } from './settings';
import { canonicalSettings } from './settings-file';

/**
 * The synchronised replica (UC-029, FR-058, FR-059, NFR-022, NFR-023, DD-002).
 *
 * Platform-free, like `settings-file.ts` next door and for the same reason: this
 * module knows what the replica *is* and what should happen to it, never how to
 * reach `browser.storage.sync`. Every decision is a pure function of the state
 * handed to it, so the layout, the completeness check, the delta and the rate
 * gate are all testable without a browser — and `platform/sync-store.ts` is left
 * as an executor that reads, calls `planPush` or `planPull`, and writes what it
 * is told. NFR-015's argument, applied to a second engine.
 *
 * **Local storage is the store; this is a replica** (BR-029-2). Nothing that
 * fills a page ever reads from here. A change that arrives becomes local through
 * the same single-replacement write every other settings change uses (BR-024-1),
 * and a local change is written through to the replica afterwards. The direction
 * is never ambiguous, which is what keeps a settings state from being assembled
 * half from one store and half from the other.
 *
 * **What the two browsers agree and disagree about, measured 2026-08-28.** Every
 * semantic this module depends on was checked in a real Gecko by installing a
 * probe add-on, because the Firefox harnesses cannot reach an installed add-on's
 * own storage (BiDi refuses to navigate a content context to a `moz-extension:`
 * URL). They agree on the three things that matter: `storage.sync` accepts
 * writes with no account signed in, both quotas are enforced, and
 * `storage.onChanged` fires with `areaName === 'sync'`. They differ in two ways
 * this module is already built for rather than adjusted for. Firefox exposes
 * **none** of the `QUOTA_BYTES*` constants — they read `undefined` — which costs
 * nothing here because the ceiling is found by attempting the write and reading
 * the refusal, never by comparing against a documented number. And **Firefox
 * hands stored objects back in insertion order where Chromium alphabetises
 * them**, which is exactly why the delta compares through `stableJson` instead
 * of trusting either: a comparison written against one browser's habit is a
 * comparison that rewrites every shard on the other.
 *
 * **The layout is DD-002's L3, at eight rules a shard**, and both halves of that
 * were measured rather than chosen (`pnpm run spike:syncquota`). Sharding is the
 * only candidate layout that carries a real configuration at all: the
 * reference's single key exceeds the per-item quota before the first global rule
 * once profiles are present. Eight is the blast radius — what one lost key
 * costs when two devices write in the same window — and it costs two rules of a
 * 401-rule ceiling to buy a quarter of the discard that packing to the item
 * quota would.
 */

/**
 * Rules or profiles to a key (DD-002, measured 2026-08-22).
 *
 * Not a number anyone picked from the shape of the data — it is the answer to
 * "how much should a conflict destroy", and the capacity it spends is the
 * measurement: 399 rules against 401 for shards packed to the item quota, at a
 * quarter of the blast radius. Four was defensible and costs one rule more;
 * eight is where the item count stays clear of the 512-item limit, which is the
 * one quota with no headroom to spare if a later section adds keys of its own.
 */
export const SYNC_SHARD_SIZE = 8;

/**
 * Where synchronisation stops carrying the configuration, in rules (DD-002,
 * measured 2026-08-22 and reproduced 2026-08-28).
 *
 * Not a limit this layout imposes and not one anyone chose: it is where a
 * 399-rule configuration of the measured shape meets `storage.sync`'s *total*
 * quota, and it moves with what else the configuration holds — the fixture
 * behind it carries four profiles, two exclusion lists and both keyword lists,
 * which is why the screen says "roughly". Here rather than in the catalog so
 * that the number the standing sentence quotes and the number DD-002 measured
 * cannot come apart in a translation.
 */
export const SYNC_RULE_CEILING = 399;

/** The key naming what the replica contains. Read first, and trusted for nothing else. */
const INDEX_KEY = 'index';

/** The section keys, in the canonical shape's own order. Rules and profiles are sharded away from these. */
const SECTION_KEYS = ['locale', 'exclusions', 'behaviour', 'passwords', 'sources', 'triggers'] as const;

/** What the replica holds, as the browser hands it back. */
export type SyncItems = Readonly<Record<string, unknown>>;

/**
 * What the store is doing, in the only three words the screen is allowed to use
 * (BR-029-6).
 *
 * Written, refused, stopped — never "synced" and never "your devices are up to
 * date". The platform reports no such fact (A4): a write can succeed into a
 * store that no signed-in account is carrying anywhere, and a screen asserting
 * otherwise would be FR-059's failure mode inverted, confidence where the user
 * needed truth. `waiting` is the fourth because it is about *this* device and is
 * observable here: a change is queued behind the rate gate and has not been
 * written yet.
 */
export type SyncOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'written' }
  | { readonly kind: 'adopted' }
  /** A1: the configuration outgrew the store. `rules` is what it held when it stopped. */
  | { readonly kind: 'stopped'; readonly rules: number }
  /** A4, and everything else a store can refuse a *write* for. The reason is the platform's own words. */
  | { readonly kind: 'refused'; readonly reason: string }
  /**
   * The store could not be *read*, which is a different fact from refusing a
   * write and gets a different sentence.
   *
   * It exists because the alternative was worse than a vague message. A failed
   * read used to be answered with an empty object, and an empty store is a
   * meaningful state — it is the one this device may seed. Conflating them made
   * a transient read failure look like a store with nothing in it, and the push
   * then wrote *every* key: a whole-configuration write, which is the exact
   * last-writer-wins blast radius the sharded delta exists to prevent. Telling
   * the two apart is what the outcome is for; saying so is the smaller half.
   */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /**
   * A configuration arrived and could not be saved *here*.
   *
   * Local storage refusing a write is not the synchronised store refusing
   * anything, and reporting it as one produced a sentence that named the wrong
   * subject — the bar NFR-020 sets is that a failure states its own cause. The
   * settings on this device are untouched (NFR-021 leaves the previous state
   * whole), which is the other half of what has to be said.
   */
  | { readonly kind: 'arrival-unsaved'; readonly reason: string };

/**
 * What this device has decided about synchronisation.
 *
 * **Stored locally and deliberately never carried** (BR-029-1). A toggle that
 * travelled would switch synchronisation off everywhere the moment one device
 * opted out — the single-key conflict wearing a settings-screen face — so none
 * of this is in `Settings`, which also keeps it out of the export file, the
 * import and the restore. Turning sync on is a decision about *this* browser,
 * and nothing that moves a configuration between machines should be able to make
 * it on another machine's behalf.
 */
export type SyncPrefs = {
  readonly enabled: boolean;
  /**
   * Step 3 is unanswered: sync was turned on over a store that already held a
   * different configuration, and neither direction runs until the user says
   * which one wins. Not a modal — the choice sits in the section, and until it
   * is made the replica and the device are both left exactly as they are.
   */
  readonly choicePending: boolean;
  /** When the last write *call* was made, in epoch milliseconds. The rate gate's whole state. */
  readonly lastWriteAt: number;
  /** A local change has not reached the replica. Durable, so a worker that dies mid-wait does not lose it. */
  readonly pending: boolean;
  /**
   * The fingerprint of the configuration this device knows is in the replica.
   *
   * Set whenever local and the replica are known to agree — after a successful
   * push, after an arrival is adopted, and whenever a push finds nothing to
   * write. Empty before any of those has happened, which reads as "this device
   * has never agreed with the store about anything" and is the honest starting
   * point.
   *
   * This exists because the pull half has to answer a question the replica alone
   * cannot: local and the store differ — which way? See `planPull`.
   */
  readonly agreed: string;
  readonly outcome: SyncOutcome;
};

export const DEFAULT_SYNC_PREFS: SyncPrefs = {
  enabled: false,
  choicePending: false,
  lastWriteAt: 0,
  pending: false,
  agreed: '',
  outcome: { kind: 'idle' },
};

/**
 * The shortest gap between write calls that keeps NFR-023, derived rather than
 * picked.
 *
 * The requirement bounds *write operations* at 100 an hour under continuous
 * editing, and DD-002 measured what an operation is: a burst of one-key writes
 * and a burst of thirteen-key writes both stopped at exactly 120, so the browser
 * counts a **call**, not a key. A flush here makes at most two — a `set`, and a
 * `remove` when the rule list shrank enough to drop a shard — so 3600 / 72 = 50
 * flushes an hour is 100 calls in the worst case and fewer in the ordinary one.
 *
 * The bound is a product decision rather than a platform limit (the platform
 * allows 1,800 an hour), and BR-029-4 leaves the interval to implementation for
 * exactly this reason: what has to be true is the bound, and this is the number
 * that makes it true by arithmetic instead of by hoping the user types slowly.
 */
export const SYNC_MIN_INTERVAL_MS = 72_000;

/**
 * Whether a change to the preferences is one the engine has work to do about.
 *
 * The engine writes the preferences itself — a claimed write time, an outcome,
 * a cleared pending flag — and it also *wakes* on preference changes, because
 * turning the toggle on is how a push is asked for. Without this question those
 * two facts are a loop: every write of an outcome wakes a flush, whose own
 * bookkeeping writes another outcome. That loop is not theoretical. It was built
 * on 2026-08-28, and what it produced was worse than a busy worker: the second
 * flush ran *inside* the first one's await, read a write time the first had just
 * claimed, and reported the change as queued — so a replica that had been
 * written correctly sat behind a screen saying it was still waiting, permanently.
 *
 * Only two transitions are work, and both of them are the *user* deciding
 * something: synchronisation switched on, and step 3 answered. Everything else
 * the preferences carry is a record of what already happened, and a record is
 * not an instruction.
 *
 * **A pending flag going up is deliberately not one of them**, which is the
 * second half of the same lesson. It looks like work — it is precisely the
 * statement that there is something to send — but the only thing that ever
 * raises it is the settings-change handler, which flushes for itself in the
 * same queued step. Waking on it too ran a second flush *behind* the first,
 * inside the write time the first had just claimed, so it reported the change
 * as queued — and on the ceiling path that meant a stop the user had to act on
 * was replaced by a reassuring sentence about a queue, a second after it
 * appeared. Every user decision that raises the flag also flips one of the two
 * above, so nothing is lost by not watching it.
 */
export function wakesEngine(before: unknown, after: unknown): boolean {
  const was = readWakeFields(before);
  const now = readWakeFields(after);
  return (!was.enabled && now.enabled) || (was.choicePending && !now.choicePending);
}

function readWakeFields(stored: unknown): { enabled: boolean; choicePending: boolean } {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    enabled: record['enabled'] === true,
    choicePending: record['choicePending'] === true,
  };
}

/**
 * What to say while a change waits behind the rate gate — and when to say
 * nothing at all.
 *
 * A queued retry is not news that supersedes a failure. The ceiling (A1) and a
 * refusal (A4) are the two outcomes the user has something to *do* about —
 * remove rules, or find out why the store said no — and both are reached with
 * the change still pending, so the very next flush is inside the gate and would
 * otherwise paint "a change is queued, it will go shortly" over them. That
 * sentence is true and it is the wrong thing to say: it reads as progress, which
 * is the reassuring direction BR-029-6 exists to keep this screen out of.
 *
 * `undefined` means leave the outcome alone, which is how a status line comes to
 * hold the most important true thing rather than the most recent one.
 */
export function outcomeWhileWaiting(current: SyncOutcome): SyncOutcome | undefined {
  switch (current.kind) {
    // The three the user has something to do about, and one of them is not
    // about this store at all: an arrival that could not be saved locally is a
    // fault on this device, and a sentence about a queue to the synchronised
    // store is no more relevant to it than it is to a ceiling.
    case 'stopped':
    case 'refused':
    case 'arrival-unsaved':
      return undefined;
    case 'waiting':
      return undefined;
    // `unreadable` is included deliberately. Reaching a wait means the store was
    // just read successfully to plan against, so a standing read failure is
    // stale by the time this is asked — leaving it up would be the one thing
    // this function exists to prevent, in the other direction.
    case 'unreadable':
    case 'idle':
    case 'written':
    case 'adopted':
      return { kind: 'waiting' };
  }
}

/**
 * The whole configuration as the replica holds it (step 4).
 *
 * Sections keep their canonical shape and their canonical key names, so a reader
 * looking at the store sees the same words the export file uses. Rules and
 * profiles are sharded; everything else is one key, because nothing else in the
 * schema grows without bound and a section that fits has no reason to be split.
 *
 * `index` names the counts rather than the shard names. A reader that trusted
 * the key list alone could not tell a shard that has not arrived yet from one
 * that was never written, and those are different: the first is a replica to
 * wait for, the second is a replica to use. The counts make the difference
 * checkable — see `readReplica`.
 */
export function syncLayout(settings: Settings): SyncItems {
  const canonical = canonicalSettings(settings);
  const rules = canonical['rules'] as readonly unknown[];
  const profiles = canonical['profiles'] as readonly unknown[];

  const items: Record<string, unknown> = {
    [INDEX_KEY]: {
      version: canonical['version'],
      rules: rules.length,
      profiles: profiles.length,
    },
  };
  for (const key of SECTION_KEYS) items[key] = canonical[key];
  for (const [n, shard] of shards(rules).entries()) items[`rules.${n}`] = shard;
  for (const [n, shard] of shards(profiles).entries()) items[`profiles.${n}`] = shard;
  return items;
}

/** A list cut into fixed-size runs. Fixed rather than packed: the size *is* the blast radius. */
function shards(list: readonly unknown[]): readonly (readonly unknown[])[] {
  const out: (readonly unknown[])[] = [];
  for (let at = 0; at < list.length; at += SYNC_SHARD_SIZE) {
    out.push(list.slice(at, at + SYNC_SHARD_SIZE));
  }
  return out;
}

/** How many shards a list of `count` entries occupies. Zero entries is zero shards, not one empty one. */
function shardCount(count: number): number {
  return Math.ceil(count / SYNC_SHARD_SIZE);
}

/**
 * What the store holds, and whether it can be believed.
 *
 * Four answers rather than two, because "there is nothing usable here" hides a
 * distinction the caller has to act on differently. An **empty** store is one
 * this device may seed (step 3). An **incomplete** one is a replica whose index
 * names shards that are not all present — either mid-arrival from another
 * device, or a write that failed partway — and the only safe thing to do with it
 * is wait, because applying it would be applying a prefix of somebody's rule
 * list as though it were the list (A1's "thin copy", BR-029-5). A **stopped**
 * one is the mark A1 leaves when the configuration outgrew the store. Only
 * **usable** reassembles.
 *
 * The reassembled state goes through `parseSettings` like every other stored
 * state, which is A6 in one line: shards from a newer build are read tolerantly,
 * keeping what this schema recognises and defaulting the rest. The newer device
 * still holds what was dropped; this one does not pretend to.
 */
export type ReplicaRead =
  | { readonly state: 'empty' }
  | { readonly state: 'unreadable' }
  | { readonly state: 'stopped'; readonly rules: number }
  | { readonly state: 'incomplete'; readonly missing: readonly string[] }
  | { readonly state: 'usable'; readonly settings: Settings; readonly foreignVersion?: number };

export function readReplica(items: SyncItems): ReplicaRead {
  const index = items[INDEX_KEY];
  if (index === undefined) return { state: 'empty' };
  if (typeof index !== 'object' || index === null || Array.isArray(index)) return { state: 'unreadable' };

  const fields = index as Record<string, unknown>;

  // A1's mark, read before the counts. A stopped replica may still carry a
  // complete-looking set of shards — the write that failed was the *new* one —
  // and reading it as usable is how a device comes to apply a configuration the
  // user was told had stopped being carried.
  if (fields['stopped'] === true) {
    return { state: 'stopped', rules: typeof fields['rules'] === 'number' ? fields['rules'] : 0 };
  }

  const rules = fields['rules'];
  const profiles = fields['profiles'];
  if (typeof rules !== 'number' || typeof profiles !== 'number') return { state: 'unreadable' };
  if (!Number.isInteger(rules) || !Number.isInteger(profiles) || rules < 0 || profiles < 0) {
    return { state: 'unreadable' };
  }

  const expected = [
    ...SECTION_KEYS,
    ...Array.from({ length: shardCount(rules) }, (_, n) => `rules.${n}`),
    ...Array.from({ length: shardCount(profiles) }, (_, n) => `profiles.${n}`),
  ];
  const missing = expected.filter((key) => items[key] === undefined);
  if (missing.length > 0) return { state: 'incomplete', missing };

  const assembled: Record<string, unknown> = { version: fields['version'] };
  for (const key of SECTION_KEYS) assembled[key] = items[key];
  assembled['rules'] = collect(items, 'rules', shardCount(rules));
  assembled['profiles'] = collect(items, 'profiles', shardCount(profiles));

  const settings = parseSettings(assembled);
  const version = fields['version'];
  // Named rather than refused (A6). A version this build does not know about is
  // a mixed-version fleet, which is normal — an updated laptop beside an
  // unupdated desktop — and the tolerant parser above has already kept what it
  // could. The number travels so the screen can say where the state came from.
  return typeof version === 'number' && version !== 1
    ? { state: 'usable', settings, foreignVersion: version }
    : { state: 'usable', settings };
}

/** The shards of one list, joined. A shard that is not an array contributes nothing rather than throwing. */
function collect(items: SyncItems, prefix: string, count: number): readonly unknown[] {
  const out: unknown[] = [];
  for (let n = 0; n < count; n++) {
    const shard = items[`${prefix}.${n}`];
    if (Array.isArray(shard)) out.push(...(shard as readonly unknown[]));
  }
  return out;
}

/**
 * The keys that have to move, and the keys that have to go.
 *
 * **Only what changed**, which is not an optimisation — it is the whole of
 * DD-002's blast-radius argument. Rewriting every shard on every save would make
 * last-writer-wins apply to the *configuration* rather than to a shard of it, so
 * two devices editing different rules would destroy each other's work in full
 * instead of colliding only where they actually collided. Sharding buys nothing
 * unless the writer respects it.
 *
 * Comparison is by canonical JSON, which is safe here for the reason
 * `canonicalSettings` exists: both sides were built by it, so key order is a
 * property of the schema rather than of whichever store the value came back
 * from. Comparing raw values would call an alphabetised echo a change and write
 * on every sync event, forever.
 */
export function syncDelta(stored: SyncItems, next: SyncItems): {
  readonly set: Readonly<Record<string, unknown>>;
  readonly remove: readonly string[];
} {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (stableJson(stored[key]) !== stableJson(value)) set[key] = value;
  }
  const remove = Object.keys(stored).filter((key) => !(key in next));
  return { set, remove };
}

/**
 * A value as a string that says what it *is*, not how it was ordered.
 *
 * `canonicalSettings` fixes the order of everything this module writes, and
 * that is only half the problem: the other side of the comparison came back out
 * of `chrome.storage.sync`, which hands every object back with its keys
 * alphabetised at every level. Comparing the canonical form against an
 * alphabetised one calls every section a change, on every flush, forever — and
 * the damage is not the writes. It is that a save then rewrites *every shard*,
 * which makes last-writer-wins apply to the whole configuration instead of to
 * eight rules of it, so two devices editing different rules destroy each other's
 * work in full. DD-002's entire blast-radius argument would have been undone by
 * a key order, silently, with every screen reporting success.
 *
 * Found on 2026-08-28 by `scripts/e2e-sync.mjs` and not by the unit suite, which
 * had compared two canonical layouts against each other — the one input shape
 * the real store never produces.
 *
 * **Arrays keep their order.** Sorting them would make this the second place in
 * the project where rule order stopped being behaviour (FR-031), and a delta
 * that called two differently ordered rule lists equal would leave the replica
 * holding a precedence nobody chose.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(stableForm(value));
}

function stableForm(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableForm);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = stableForm(source[key]);
  return out;
}

/**
 * The index alone, marked as not current (A1).
 *
 * One small key, written after a rejected write, and it is what stops the
 * failure from being local to this device. Without it another browser reads a
 * replica that still looks complete — the *previous* configuration, whole — and
 * applies it as the answer, so a user who added forty rules on their laptop
 * would watch their desktop go on filling with the configuration from before,
 * with both screens reporting success. A partial carry is not a stale
 * configuration; it is a different one, and the mark is what makes that a fact
 * the system states rather than an inconsistency the user diagnoses.
 *
 * The counts are kept beside the mark so the screen on the *other* device can
 * say what stopped it, in rules rather than in bytes.
 */
export function stoppedIndex(settings: Settings): Readonly<Record<string, unknown>> {
  return {
    [INDEX_KEY]: {
      version: settings.version,
      rules: settings.rules.length,
      profiles: settings.profiles.length,
      stopped: true,
    },
  };
}

/**
 * Whether a write failure was the store saying "this no longer fits" (A1) rather
 * than saying anything else (A4).
 *
 * Matched on the platform's own words, both of which were measured rather than
 * read off a documentation page. Chromium refuses with `Resource::kQuotaBytes`
 * for the total and `Resource::kQuotaBytesPerItem` for one item
 * (`pnpm run spike:syncquota`); Firefox says
 * `QuotaExceededError: storage.sync API call exceeded its quota limitations.`
 * for *both*, measured on 2026-08-28 in a real Gecko. Loose on purpose, and the
 * asymmetry is deliberate: getting this wrong in the safe direction reports a
 * quota stop as an unexplained refusal, which is still true and still
 * actionable; getting it wrong the other way tells a user to delete rules over a
 * store that was merely signed out.
 *
 * The rate limit is deliberately excluded. It is a refusal to write *now*, not a
 * refusal to write at all, and reporting it as a ceiling would tell a user their
 * configuration is too large when they have merely been typing quickly.
 */
export function isQuotaFailure(reason: string): boolean {
  return /quota/i.test(reason) && !/WRITE_OPERATIONS|per.?(minute|hour)/i.test(reason);
}

/** What the push half should do, decided before anything touches a store. */
export type PushPlan =
  | { readonly do: 'nothing'; readonly why: 'disabled' | 'choice-pending' | 'unchanged' }
  | { readonly do: 'wait'; readonly forMs: number }
  | {
      readonly do: 'write';
      readonly set: Readonly<Record<string, unknown>>;
      readonly remove: readonly string[];
    };

/**
 * Step 5, this device's half: a local change written through at the replica's
 * own pace (BR-029-4).
 *
 * Leading edge — a change after a quiet period goes now, so a user who edits one
 * setting and closes the page does not leave it queued behind a timer. Under
 * continuous editing the gate is what holds NFR-023, and `wait` returns the
 * remaining milliseconds rather than a boolean so the caller has something to
 * schedule against instead of a poll.
 *
 * `unchanged` is the answer that keeps the two directions from chasing each
 * other. This device's own write comes back as a sync change, which triggers a
 * pull, which finds the replica equal to local and adopts nothing, which
 * triggers no further write — but only because the delta is computed against
 * what the store actually holds. A push that assumed it knew would write again
 * on every event.
 */
export function planPush(input: {
  readonly settings: Settings;
  readonly stored: SyncItems;
  readonly prefs: SyncPrefs;
  readonly now: number;
}): PushPlan {
  if (!input.prefs.enabled) return { do: 'nothing', why: 'disabled' };
  if (input.prefs.choicePending) return { do: 'nothing', why: 'choice-pending' };

  const next = syncLayout(input.settings);
  const delta = syncDelta(input.stored, next);
  if (Object.keys(delta.set).length === 0 && delta.remove.length === 0) {
    return { do: 'nothing', why: 'unchanged' };
  }

  const earliest = input.prefs.lastWriteAt + SYNC_MIN_INTERVAL_MS;
  if (input.now < earliest) return { do: 'wait', forMs: earliest - input.now };

  return { do: 'write', set: delta.set, remove: delta.remove };
}

/** What the pull half should do. `adopt` is the only outcome that writes anything locally. */
export type PullPlan =
  | {
      readonly do: 'nothing';
      readonly why:
        | 'disabled'
        | 'choice-pending'
        | 'local-newer'
        | 'empty'
        | 'unchanged'
        | 'incomplete'
        | 'stopped'
        | 'unreadable';
    }
  | { readonly do: 'adopt'; readonly settings: Settings };

/**
 * Step 5, the other half: a change from another device applied here as one
 * replacement (BR-029-2, BR-024-1).
 *
 * The comparison is between two states in the same normal form, which is the
 * same question `main.ts` asks about a foreign writer and for the same reason:
 * both sides through the canonical shape, so what is being asked is "did the
 * store change" rather than "did anything about this object differ". Without it
 * an alphabetised echo of this device's own write reads as an arrival, and the
 * page announces a change from elsewhere every time the user edits anything.
 *
 * Every non-adopting answer is named rather than collapsed to a boolean, because
 * three of them are things the screen has to be able to say: an incomplete
 * replica is one to wait for, a stopped one is A1 on another device, and an
 * unreadable index is a store this build cannot make sense of at all.
 */
export function planPull(input: {
  readonly settings: Settings;
  readonly stored: SyncItems;
  readonly prefs: SyncPrefs;
}): PullPlan {
  if (!input.prefs.enabled) return { do: 'nothing', why: 'disabled' };
  if (input.prefs.choicePending) return { do: 'nothing', why: 'choice-pending' };

  /**
   * **A local change that has not reached the replica outranks anything arriving.**
   *
   * Without this the rate gate becomes a way to lose the user's work, and it was
   * one: an edit made inside the gate is held locally while the push waits, and
   * any sync event in that window — another device's write, or this device's own
   * previous write echoing back — finds a replica that differs from local and
   * adopts it, silently reverting the edit the user just made. The screen then
   * says a configuration arrived, which is true, and says nothing about what it
   * replaced, which is the part that mattered.
   *
   * **Asked of state rather than of the pending flag, and the first attempt at
   * this got that wrong.** The flag is raised by the settings-change handler,
   * which the browser runs *after* the local write it is reacting to — so a pull
   * queued by an earlier sync event runs before the flag goes up and sees a
   * configuration already newer than the store with nothing marking it as such.
   * The fingerprint has no such window: it is a property of the settings
   * themselves, compared against the last state this device knows reached the
   * replica, so it is true the moment the write lands rather than the moment
   * something notices.
   *
   * Deferring rather than merging is the right answer and not merely the easy
   * one. The push is already queued, it writes only the shards this device
   * actually changed, and the other device's shards survive it untouched — which
   * is the sharded merge DD-002 designed. The merged store then differs from
   * what this device pushed, the next sync event finds local and `agreed` equal,
   * and the merge is adopted here. Adopting first would throw the local edit
   * away before it ever reached the store, so there would be nothing to merge.
   *
   * Found on 2026-08-28 by `scripts/e2e-sync.mjs`, twice: once as the defect and
   * once as the wrong fix. Every plan passed on its own both times, and what was
   * wrong was the order two of them ran in — which is the tier distinction this
   * project keeps rediscovering.
   */
  if (settingsFingerprint(input.settings) !== input.prefs.agreed) {
    return { do: 'nothing', why: 'local-newer' };
  }

  const replica = readReplica(input.stored);
  switch (replica.state) {
    case 'empty':
      return { do: 'nothing', why: 'empty' };
    case 'unreadable':
      return { do: 'nothing', why: 'unreadable' };
    case 'stopped':
      return { do: 'nothing', why: 'stopped' };
    case 'incomplete':
      return { do: 'nothing', why: 'incomplete' };
    case 'usable':
      return sameConfiguration(replica.settings, input.settings)
        ? { do: 'nothing', why: 'unchanged' }
        : { do: 'adopt', settings: replica.settings };
  }
}

/**
 * Whether two states are the same configuration, in the normal form both stores
 * hand back differently.
 *
 * Exported because the options page asks the same question about the same two
 * sides when it draws step 3's choice, and two implementations of "are these the
 * same" is how a screen comes to offer a choice between two identical
 * configurations.
 */
export function sameConfiguration(left: Settings, right: Settings): boolean {
  return JSON.stringify(canonicalSettings(left)) === JSON.stringify(canonicalSettings(right));
}

/**
 * A short, stable stand-in for a whole configuration.
 *
 * Kept in the preferences so that the pull half can ask "has local changed since
 * this device and the store last agreed" without keeping a second copy of the
 * settings beside the settings. The canonical form is what is hashed, so the
 * answer is about the configuration rather than about the key order storage
 * happened to hand back.
 *
 * FNV-1a, twice, over the same bytes with different offsets, joined with the
 * length. Not cryptographic and it does not need to be: nothing here is
 * defended against an adversary choosing an input, and the cost of the
 * collision this could have — two different configurations fingerprinting alike
 * — is one deferred pull that should have run, corrected by the next change
 * either device makes. The length is included because it is free and it
 * separates the overwhelming majority of near-misses on its own.
 */
export function settingsFingerprint(settings: Settings): string {
  const text = JSON.stringify(canonicalSettings(settings));
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}.${a.toString(36)}.${b.toString(36)}`;
}

/**
 * What step 3 has to show: this device's configuration and the store's, in
 * counts, so the sentence can name both sides before either is discarded.
 *
 * Counts rather than a diff, matching UC-028's confirmation and for its reason:
 * the user is deciding which of two configurations survives, and "31 rules and 4
 * profiles here, 12 rules and 1 profile there" is a decision they can make,
 * where a list of what differs is one they would have to study.
 */
export type SyncSides = {
  readonly here: { readonly rules: number; readonly profiles: number };
  readonly there: { readonly rules: number; readonly profiles: number };
};

export function syncSides(here: Settings, there: Settings): SyncSides {
  return {
    here: { rules: here.rules.length, profiles: here.profiles.length },
    there: { rules: there.rules.length, profiles: there.profiles.length },
  };
}
