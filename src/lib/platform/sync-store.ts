import { browser } from 'wxt/browser';
import {
  DEFAULT_SYNC_PREFS,
  isQuotaFailure,
  outcomeWhileWaiting,
  planPull,
  planPush,
  settingsFingerprint,
  stoppedIndex,
  wakesEngine,
  type SyncItems,
  type SyncOutcome,
  type SyncPrefs,
} from '../sync';
import { getSettings, saveSettings } from './settings-store';

/**
 * The synchronised replica's executor (UC-029).
 *
 * Deliberately thin, and thin in a way that is checkable rather than claimed:
 * every question with an answer worth arguing about — what the layout is, what
 * has to move, whether an incomplete replica may be applied, whether a refusal
 * was the ceiling, when the next write is allowed — is decided in `lib/sync.ts`,
 * which is platform-free and held to NFR-012's floor. What is left here is
 * reading two stores, writing them, and doing what the plan said. Its coverage
 * allowlist entry in `scripts/check-coverage-scope.mjs` says the same thing, and
 * stays true only for as long as this file makes no decisions of its own.
 *
 * **Both contexts import this; only the background runs the engine.** The
 * options page reads the preferences and the replica to draw its section and to
 * offer step 3's choice, and writes the preferences when the user answers. It
 * never writes the replica. `startSyncEngine` is called once, from the
 * background, and everything that touches `storage.sync` for real is behind it —
 * so there is one writer, and the double-push that two writers reacting to the
 * same storage event would produce cannot happen.
 */

/** The preferences key, in local storage beside `settings` and never in it (BR-029-1). */
const PREFS_KEY = 'sync';

/**
 * The preferences, or the shipped ones.
 *
 * Tolerant in the same way `parseSettings` is, and for the same reason: a
 * preferences record this build cannot read must not stop the extension, and
 * "synchronisation is off" is the safe reading of an unreadable answer — it
 * writes nothing anywhere until the user turns it on again.
 */
export async function readSyncPrefs(): Promise<SyncPrefs> {
  try {
    const stored = await browser.storage.local.get(PREFS_KEY);
    return parsePrefs(stored[PREFS_KEY]);
  } catch {
    return DEFAULT_SYNC_PREFS;
  }
}

function parsePrefs(stored: unknown): SyncPrefs {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SYNC_PREFS;
  const record = stored as Record<string, unknown>;
  return {
    enabled: record['enabled'] === true,
    choicePending: record['choicePending'] === true,
    lastWriteAt: typeof record['lastWriteAt'] === 'number' && Number.isFinite(record['lastWriteAt'])
      ? record['lastWriteAt']
      : 0,
    pending: record['pending'] === true,
    agreed: typeof record['agreed'] === 'string' ? record['agreed'] : '',
    outcome: parseOutcome(record['outcome']),
  };
}

function parseOutcome(stored: unknown): SyncOutcome {
  if (typeof stored !== 'object' || stored === null) return { kind: 'idle' };
  const record = stored as Record<string, unknown>;
  switch (record['kind']) {
    case 'waiting':
      return { kind: 'waiting' };
    case 'written':
      return { kind: 'written' };
    case 'adopted':
      return { kind: 'adopted' };
    case 'stopped':
      return { kind: 'stopped', rules: typeof record['rules'] === 'number' ? record['rules'] : 0 };
    case 'refused':
      return { kind: 'refused', reason: typeof record['reason'] === 'string' ? record['reason'] : '' };
    case 'unreadable':
      return { kind: 'unreadable', reason: typeof record['reason'] === 'string' ? record['reason'] : '' };
    case 'arrival-unsaved':
      return {
        kind: 'arrival-unsaved',
        reason: typeof record['reason'] === 'string' ? record['reason'] : '',
      };
    default:
      return { kind: 'idle' };
  }
}

/** Preferences, changed a field at a time. Whole-record writes, like every other store here. */
export async function writeSyncPrefs(patch: Partial<SyncPrefs>): Promise<SyncPrefs> {
  const next: SyncPrefs = { ...(await readSyncPrefs()), ...patch };
  await browser.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

/**
 * Everything the synchronised store holds — or why it could not be asked.
 *
 * **A failed read is never answered with an empty object**, and the distinction
 * is not cosmetic. An empty store is a meaningful state: it is the one this
 * device may seed, and seeding writes every key. So a read that failed, reported
 * as `{}`, made the push compute a delta against nothing and rewrite the whole
 * configuration — a single whole-configuration write, which is precisely the
 * last-writer-wins blast radius the sharded delta exists to prevent, and it
 * would have destroyed a second device's concurrent edits in full rather than
 * eight rules of them. The pull half was safe by luck: empty reads as nothing to
 * adopt.
 *
 * Every caller therefore has to answer for the failure, which is the point of
 * returning it rather than swallowing it. There are three, and all three used to
 * be wrong in the same way — including the consent step, where a transient read
 * failure skipped step 3's question and seeded over a store that was holding a
 * different configuration all along.
 */
export type StoreRead =
  | { readonly ok: true; readonly items: SyncItems }
  | { readonly ok: false; readonly reason: string };

export async function readReplicaItems(): Promise<StoreRead> {
  try {
    return { ok: true, items: await browser.storage.sync.get(null) };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The scheduled flush, while this context is alive.
 *
 * An MV3 worker is torn down when it goes idle, so this timer is a convenience
 * and never the guarantee: `pending` is written to local storage before the wait
 * begins, and the engine flushes on start and on every subsequent settings
 * change, so a worker that dies mid-wait costs a delay rather than a write. The
 * durable alternative is `chrome.alarms`, which is a sixth permission —
 * NFR-008's list is gated at five and this is not worth spending one of them on.
 */
let scheduled: ReturnType<typeof setTimeout> | undefined;

/**
 * One engine operation at a time, ever.
 *
 * Every function below is a read-modify-write over two stores, and the events
 * that drive them arrive while those awaits are outstanding — a settings change
 * lands during a flush, a sync change lands during a pull, and the engine's own
 * bookkeeping write lands during both. Run concurrently they clobber each
 * other's preferences: two `writeSyncPrefs` calls that each read before either
 * wrote leave whichever finished last in charge of fields it never looked at.
 *
 * Built without this on 2026-08-28 and found by the harness rather than by the
 * unit suite, which is the tier distinction this project keeps writing down.
 * Every operation passed in isolation; what was wrong was the state the second
 * one was applied to. A replica written correctly sat behind a screen reporting
 * the change as still queued, because a re-entrant flush had read a write time
 * the outer one had claimed a moment earlier and concluded it had to wait.
 *
 * Rejections are swallowed rather than allowed to break the chain: an operation
 * that throws has already reported itself through the preferences, and a chain
 * that stopped at the first failure would silently disable synchronisation for
 * the life of the worker.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work).catch(() => undefined);
}

/**
 * Registers both directions. Called once, from the background.
 *
 * Listeners at registration time rather than lazily, for the reason
 * `settings-store.ts` gives: an MV3 background is started *by* events, and a
 * listener attached after the first read would miss the change that woke it.
 *
 * The preference wake is filtered by `wakesEngine`, which is what stops the
 * engine's own bookkeeping from waking it: this listener is how turning the
 * toggle on asks for a push, and it also hears every outcome this file writes.
 */
export function startSyncEngine(): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'settings' in changes) enqueue(onSettingsChanged);
    if (areaName === 'local' && PREFS_KEY in changes) {
      const change = changes[PREFS_KEY];
      if (wakesEngine(change.oldValue, change.newValue)) enqueue(flush);
    }
    if (areaName === 'sync') enqueue(pull);
  });

  // The catch-up. A change written while this worker was down left `pending`
  // behind it, and this is the moment that costs nothing to check.
  enqueue(flush);
  enqueue(pull);
}

/**
 * A local change: marked pending before anything is attempted.
 *
 * The order matters and is the whole reason this is not one function with
 * `flush`. If the write is deferred by the rate gate and the worker is evicted
 * during the wait, the flag is what remembers there is something to send — so it
 * is durable *before* the gate is consulted rather than after.
 */
async function onSettingsChanged(): Promise<void> {
  const prefs = await readSyncPrefs();
  if (!prefs.enabled || prefs.choicePending) return;
  await writeSyncPrefs({ pending: true });
  await flush();
}

/**
 * Step 5's write, and A1's failure.
 *
 * `set` before `remove`, which is the ordering a reader on another device
 * depends on. The index is written in the same call as the shards it names, so a
 * store caught between the two calls holds *more* shards than the index names —
 * which `readReplica` ignores — where removing first would leave it holding
 * fewer, which `readReplica` correctly refuses as incomplete. The stale-shard
 * window costs a few hundred bytes; the other order costs an interval in which
 * no device will adopt anything.
 */
async function flush(): Promise<void> {
  const prefs = await readSyncPrefs();
  if (!prefs.enabled || prefs.choicePending) return;

  const settings = await getSettings();

  // Nothing is planned against a store this device could not read. Skipping
  // leaves `pending` up, so the next settings change or the next background
  // start tries again — which is the same retry a rate-gated write already
  // relies on, and a great deal better than seeding over a store whose contents
  // are unknown.
  const read = await readReplicaItems();
  if (!read.ok) {
    await recordUnreadable(prefs, read.reason);
    return;
  }

  const plan = planPush({ settings, stored: read.items, prefs, now: Date.now() });

  switch (plan.do) {
    case 'nothing': {
      // `unchanged` is the end of a successful round trip as often as it is a
      // no-op: this device's own write has come back, and there is nothing left
      // pending. It is also one of the three moments local and the replica are
      // known to agree, so it records the fingerprint the pull half reads —
      // missing it here would leave a device that adopted a configuration and
      // had nothing to push deferring every arrival for ever.
      //
      // The standing outcome is left alone, with one exception. A read failure
      // is *stale* by the time this line is reached: getting here means the
      // store was just read successfully and found holding exactly this
      // configuration. Leaving it up would keep a sentence on screen that was
      // true when written and is not true now, which is the whole of what this
      // review round was about. `written` is what replaces it, and it is the
      // honest word — the store demonstrably holds this configuration, and the
      // sentence behind that key already disclaims knowing whether any other
      // device received it (BR-029-6).
      if (plan.why !== 'unchanged') return;
      const agreed = settingsFingerprint(settings);
      const staleRead = prefs.outcome.kind === 'unreadable';
      if (prefs.pending || prefs.agreed !== agreed || staleRead) {
        // Spelled out rather than spread conditionally. `exactOptionalPropertyTypes`
        // is on in this project, and a conditional spread is the shape most likely
        // to mean something subtly different from what it reads as.
        await writeSyncPrefs(
          staleRead
            ? { pending: false, agreed, outcome: { kind: 'written' } }
            : { pending: false, agreed },
        );
      }
      return;
    }

    case 'wait': {
      // Not unconditionally: a queued retry must not paint over a ceiling, a
      // refused write, or an arrival that could not be saved here — all three
      // are reached with the change still pending, and all three are things the
      // user has something to do about. `outcomeWhileWaiting` owns that list, so
      // a fourth such outcome is decided once rather than remembered here.
      const waiting = outcomeWhileWaiting(prefs.outcome);
      if (waiting !== undefined) await writeSyncPrefs({ outcome: waiting });
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        enqueue(flush);
      }, plan.forMs);
      return;
    }

    case 'write':
      await write(plan.set, plan.remove, settings);
      return;
  }
}

async function write(
  set: Readonly<Record<string, unknown>>,
  remove: readonly string[],
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<void> {
  // Claimed before the call, not after. The gate's job is to bound how often
  // this device *attempts* a write, and a failed attempt costs the platform a
  // write operation exactly as a successful one does — so recording the time
  // only on success would let a store that refuses everything be retried at
  // whatever rate the events arrive.
  await writeSyncPrefs({ lastWriteAt: Date.now() });

  try {
    if (Object.keys(set).length > 0) await browser.storage.sync.set(set);
    if (remove.length > 0) await browser.storage.sync.remove([...remove]);
    // The fingerprint of what was *written*, recorded with the success and never
    // before it: it is the pull half's evidence that local holds nothing the
    // store has not seen, and recording it optimistically would make a failed
    // write look like an agreement and let the next arrival overwrite the change
    // that never went.
    await writeSyncPrefs({
      pending: false,
      agreed: settingsFingerprint(settings),
      outcome: { kind: 'written' },
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isQuotaFailure(reason)) {
      // A4 and everything like it: refused, said, and left pending so the next
      // change or the next start tries again. Nothing about the replica is
      // claimed either way, because nothing about it is known.
      await writeSyncPrefs({ outcome: { kind: 'refused', reason } });
      return;
    }

    // A1. The mark goes out even though the write it belongs to did not, and
    // it is the only part of this path that must not be skipped: without it
    // every other device goes on applying the last complete replica as though
    // it were current. Its own failure is swallowed deliberately — there is
    // nothing further to try, and the screen on *this* device says what
    // happened regardless.
    try {
      await browser.storage.sync.set(stoppedIndex(settings));
    } catch {
      /* The store is refusing writes entirely; this device still reports the stop. */
    }
    await writeSyncPrefs({ outcome: { kind: 'stopped', rules: settings.rules.length } });
  }
}

/**
 * Step 5's arrival, applied through UC-024's single-replacement path.
 *
 * `saveSettings` rather than a store write of our own: the candidate goes
 * through `parseSettings` on the way in, the options page's adoption listener
 * hears the local change and brings itself level (A3), and the background's own
 * settings cache is dropped by the same event. A replica applied any other way
 * would be a second writer of the settings state, which is the thing UC-024
 * exists to make impossible.
 */
async function pull(): Promise<void> {
  const prefs = await readSyncPrefs();
  if (!prefs.enabled || prefs.choicePending) return;

  const read = await readReplicaItems();
  if (!read.ok) {
    await recordUnreadable(prefs, read.reason);
    return;
  }

  const plan = planPull({ settings: await getSettings(), stored: read.items, prefs });
  if (plan.do !== 'adopt') return;

  // Only the local write is guarded here, and only its own failure is reported.
  // A wider `try` around this and the bookkeeping below reported a refused
  // *local* write as "synchronised storage refused the last write", which names
  // the wrong subject entirely — the store did nothing of the kind, and the
  // sentence sent the user to look at the wrong thing. NFR-020 asks a failure to
  // state its own cause, and this is the shape that keeps it able to.
  try {
    await saveSettings(plan.settings);
  } catch (error: unknown) {
    await writeSyncPrefs({
      outcome: {
        kind: 'arrival-unsaved',
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  // Adopting is the third moment the two are known to agree, and the flag
  // matters as much as the fingerprint: the adoption is itself a local settings
  // write, so the handler that hears it will mark a change pending over a
  // configuration that came *from* the store.
  //
  // Unguarded on purpose. This is a preferences write, and the queue swallows a
  // rejection; if it fails, `agreed` goes unrecorded and the next pull defers
  // rather than adopting, which is the safe direction.
  await writeSyncPrefs({
    pending: false,
    agreed: settingsFingerprint(plan.settings),
    outcome: { kind: 'adopted' },
  });
}

/**
 * Says the store could not be read, once.
 *
 * Guarded against rewriting the same outcome because both directions call it and
 * a store that is unreachable is usually unreachable for both — two identical
 * preference writes per event would be noise in every storage listener on the
 * page for no added truth.
 */
async function recordUnreadable(prefs: SyncPrefs, reason: string): Promise<void> {
  if (prefs.outcome.kind === 'unreadable' && prefs.outcome.reason === reason) return;
  await writeSyncPrefs({ outcome: { kind: 'unreadable', reason } });
}
