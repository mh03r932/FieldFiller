import { browser } from 'wxt/browser';
import {
  DEFAULT_SYNC_PREFS,
  hasUnsentChange,
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

/**
 * The preferences, in **two** local keys with exactly one writer each.
 *
 * `SyncPrefs` is still one record everywhere it is *read* — the plan functions
 * take it whole, and the screen renders it whole — but it is stored split,
 * because the two halves have different owners and merging them into one key
 * made those owners race.
 *
 *   · `sync` is the **user's** half: switched on, and step 3 outstanding. Only
 *     the options page writes it, in response to a click.
 *   · `sync.state` is the **engine's** half: what it has sent, when it last
 *     wrote, and what happened. Only the background writes it, and the engine's
 *     queue serialises it against itself.
 *
 * Held in one key, every write was a read-modify-write over both halves from two
 * contexts at once, so an engine write that had read the record before a toggle
 * landed put `enabled: false` back — switching synchronisation off underneath a
 * user who had just switched it on, with nothing anywhere saying so. Splitting
 * removes the race rather than narrowing its window, which is the same
 * single-writer discipline this feature already holds `storage.sync` to
 * (BR-029-2). Two options pages writing the user's half remains possible and is
 * the same bargain UC-024 already accepts for the settings themselves.
 *
 * **`pending` moved to the engine's half and the page stopped setting it.** It
 * was never the page's fact: "there is something unsent" is what the *plan*
 * concludes, so `flush` records it when it defers a write, and the page asks for
 * a push by flipping the half it does own — which is what `wakesEngine` watches.
 */
const CHOICE_KEY = 'sync';
const STATE_KEY = 'sync.state';

/** The user's half. Off by default, decided per device, never carried (BR-029-1). */
type SyncChoice = Pick<SyncPrefs, 'enabled' | 'choicePending'>;

/** The engine's half: a record of what it has done, never an instruction from anyone. */
type SyncState = Pick<SyncPrefs, 'pending' | 'agreed' | 'lastWriteAt' | 'outcome'>;

/**
 * Both halves, or the shipped defaults.
 *
 * Tolerant in the same way `parseSettings` is, and for the same reason: a
 * preferences record this build cannot read must not stop the extension, and
 * "synchronisation is off" is the safe reading of an unreadable answer — it
 * writes nothing anywhere until the user turns it on again.
 *
 * Safe *to read with*. It is deliberately not what the write path uses — see
 * `readStrict` below, which is the distinction `settings-store.ts` already draws
 * between `getSettings` and `readSettings`.
 */
export async function readSyncPrefs(): Promise<SyncPrefs> {
  try {
    const stored = await browser.storage.local.get([CHOICE_KEY, STATE_KEY]);
    return { ...parseChoice(stored[CHOICE_KEY]), ...parseState(stored[STATE_KEY]) };
  } catch {
    return DEFAULT_SYNC_PREFS;
  }
}

/**
 * One key, read with no net.
 *
 * `readSyncPrefs` answers a failed read with the defaults, and for rendering a
 * screen that is right. On the *write* path it is the worst thing it could do:
 * a patch merged onto defaults is written back as a whole record, so a transient
 * read failure would persist `enabled: false` and switch synchronisation off
 * silently — the user's own decision discarded by a storage hiccup, with the
 * screen calmly reporting the state it had just been given. So writes read
 * through here, where a rejection stays a rejection and the caller does not
 * write at all.
 *
 * The same argument, and the same shape, as `readSettings` beside `getSettings`.
 */
async function readStrict<T>(key: string, parse: (stored: unknown) => T): Promise<T> {
  const stored = await browser.storage.local.get(key);
  return parse(stored[key]);
}

function parseChoice(stored: unknown): SyncChoice {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return { enabled: record['enabled'] === true, choicePending: record['choicePending'] === true };
}

function parseState(stored: unknown): SyncState {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    lastWriteAt:
      typeof record['lastWriteAt'] === 'number' && Number.isFinite(record['lastWriteAt'])
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

/**
 * The user's half, written by the options page and by nothing else.
 *
 * Returns both halves so a caller can render what it has just decided without a
 * second read. A failed read of the half being patched propagates rather than
 * merging onto defaults — see `readStrict`.
 */
export async function writeSyncChoice(patch: Partial<SyncChoice>): Promise<SyncPrefs> {
  const next: SyncChoice = { ...(await readStrict(CHOICE_KEY, parseChoice)), ...patch };
  await browser.storage.local.set({ [CHOICE_KEY]: next });
  return { ...next, ...(await readStrict(STATE_KEY, parseState)) };
}

/** The engine's half, written by the background and by nothing else. */
async function writeSyncState(patch: Partial<SyncState>): Promise<void> {
  const next: SyncState = { ...(await readStrict(STATE_KEY, parseState)), ...patch };
  await browser.storage.local.set({ [STATE_KEY]: next });
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
 * other's state: two `writeSyncState` calls that each read before either
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
    if (areaName === 'local' && CHOICE_KEY in changes) {
      const change = changes[CHOICE_KEY];
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

  /**
   * **A settings change that came *from* the store is not something to send back.**
   *
   * Adopting an arrival writes local settings, which lands here like any other
   * change — so this device marked a push pending and flushed, over a
   * configuration it had just been given. In the ordinary case that push writes
   * nothing, because the delta against the store is empty, and it looked
   * harmless for exactly that reason. It is not harmless when the store moved in
   * between: a third device's write landing between the read that fed the
   * adoption and this echo makes the echo's delta non-empty, and what it then
   * writes is a *revert* of that device's change — with a blast radius set by
   * how far the two configurations differ rather than by the shard size the
   * screen promises (BR-029-3, A2).
   *
   * The fingerprint already knows the answer: `agreed` is the configuration this
   * device knows is in the replica, so local matching it means there is nothing
   * to send, by definition. An adoption sets `agreed` to what it adopted, so the
   * echo stops here rather than at the delta.
   *
   * It closes the echo, not the general case. A local edit made on top of a
   * stale baseline still pushes a delta that can revert another device's
   * concurrent change, because a delta is computed against the store as it is
   * now rather than against the state this device last agreed with. That needs a
   * per-key generation and a compare-and-set; it is recorded as a known
   * limitation on UC-029 A2 rather than left to be discovered.
   */
  const settings = await getSettings();
  if (!hasUnsentChange(settings, prefs)) return;

  await writeSyncState({ pending: true });
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
        await writeSyncState(
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
      // `pending` is recorded here rather than by whoever provoked the flush,
      // because "there is something unsent" is a conclusion of the plan and not
      // a fact any caller has. It is also what makes the flag durable across a
      // stopped worker: the write is deferred, and the next settings change or
      // the next background start finds the flag and retries.
      const waiting = outcomeWhileWaiting(prefs.outcome);
      await writeSyncState(waiting === undefined ? { pending: true } : { pending: true, outcome: waiting });
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
  await writeSyncState({ lastWriteAt: Date.now() });

  /**
   * **At most two calls, and now by construction rather than by inspection.**
   *
   * NFR-023's bound is arithmetic — two write calls a flush, 72 s apart, 100 an
   * hour — so the arithmetic is only worth as much as the "two". The shards and
   * the prune are one each; a review asked what the ceiling path costs, and
   * separating the two failures below is what makes the answer two on every
   * path instead of two on every path anyone had thought of.
   *
   * The separation is not bookkeeping. A failed `set` and a failed `remove` are
   * different events and were being reported as the same one: if the shards
   * landed and only the prune was refused, the configuration *is* carried, and
   * announcing that synchronisation has stopped would name the wrong thing
   * entirely — the same defect this feature's previous review round was about,
   * one layer down. A refused prune leaves stale keys costing quota, the next
   * flush lists them again, and the write it belongs to stands as written.
   */
  try {
    if (Object.keys(set).length > 0) await browser.storage.sync.set(set);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isQuotaFailure(reason)) {
      // A4 and everything like it: refused, said, and left pending so the next
      // change or the next start tries again. Nothing about the replica is
      // claimed either way, because nothing about it is known.
      await writeSyncState({ outcome: { kind: 'refused', reason } });
      return;
    }

    // A1. The mark goes out even though the write it belongs to did not, and it
    // is the only part of this path that must not be skipped: without it every
    // other device goes on applying the last complete replica as though it were
    // current. This is the second and last call on this path. Its own failure is
    // swallowed deliberately — there is nothing further to try, and the screen
    // on *this* device says what happened regardless.
    try {
      await browser.storage.sync.set(stoppedIndex(settings));
    } catch {
      /* The store is refusing writes entirely; this device still reports the stop. */
    }
    await writeSyncState({ outcome: { kind: 'stopped', rules: settings.rules.length } });
    return;
  }

  // The shards are in. A prune that fails from here does not undo that, so it
  // does not get to change what this device reports — and it costs no third
  // call, because the ceiling mark belongs to the branch above.
  try {
    if (remove.length > 0) await browser.storage.sync.remove([...remove]);
  } catch {
    /* Stale keys stay, costing quota; the next flush lists them again. */
  }

  // The fingerprint of what was *written*, recorded with the success and never
  // before it: it is the pull half's evidence that local holds nothing the store
  // has not seen, and recording it optimistically would make a failed write look
  // like an agreement and let the next arrival overwrite the change that never
  // went.
  await writeSyncState({
    pending: false,
    agreed: settingsFingerprint(settings),
    outcome: { kind: 'written' },
  });
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
    await writeSyncState({
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
  await writeSyncState({
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
  await writeSyncState({ outcome: { kind: 'unreadable', reason } });
}
