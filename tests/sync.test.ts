import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Profile, type Rule, type Settings } from '@/lib/settings';
import {
  DEFAULT_SYNC_PREFS,
  isQuotaFailure,
  planPull,
  planPush,
  hasUnsentChange,
  readReplica,
  sameConfiguration,
  settingsFingerprint,
  stoppedIndex,
  syncDelta,
  syncLayout,
  outcomeWhileWaiting,
  syncSides,
  wakesEngine,
  SYNC_MIN_INTERVAL_MS,
  SYNC_SHARD_SIZE,
  type SyncItems,
  type SyncPrefs,
} from '@/lib/sync';

/**
 * UC-029's replica: the layout, what may be believed about it, and what should
 * happen next.
 *
 * The floor here is argued in `vitest.config.ts` and it is worth restating at
 * the top of the suite it applies to: what this module gets wrong is which
 * configuration a *second* machine ends up with, and every wrong answer looks
 * like a working feature from either screen. Nothing below asserts against a
 * mock of `chrome.storage` — the module never touches it, which is the point of
 * splitting it from `platform/sync-store.ts`.
 */

const rule = (id: string): Rule => ({
  id,
  label: `Rule ${id}`,
  enabled: true,
  match: { mode: 'contains', pattern: id },
  generator: { type: 'email' },
  fromPersona: true,
});

const profile = (id: string, rules: readonly Rule[] = []): Profile => ({
  id,
  label: `Profile ${id}`,
  enabled: true,
  urls: [`https://${id}.example.com/*`],
  rules,
});

const withRules = (count: number, profiles: readonly Profile[] = []): Settings => ({
  ...DEFAULT_SETTINGS,
  rules: Array.from({ length: count }, (_, n) => rule(`r${n}`)),
  profiles,
});

/**
 * Synchronisation on, and this device in agreement with the store about
 * `settings` unless a case says otherwise.
 *
 * The fingerprint has to be supplied because the pull half reads it: a device
 * whose local state differs from the last thing it agreed on is one holding an
 * unsent change, and it defers rather than adopting. Defaulting it to agreement
 * is what makes every *other* test in this file be about what it says it is.
 */
const prefsOn = (settings: Settings, patch: Partial<SyncPrefs> = {}): SyncPrefs => ({
  ...DEFAULT_SYNC_PREFS,
  enabled: true,
  agreed: settingsFingerprint(settings),
  ...patch,
});

/**
 * What storage does to an object on the way back out.
 *
 * `chrome.storage` returns every object with its keys alphabetised, at every
 * level — measured in `scripts/e2e-export.mjs` rather than assumed. Reproduced
 * here because it is the exact input the delta and the comparison have to be
 * indifferent to: a state that reads back reordered must not look like a change,
 * or this device writes on every sync event for as long as it is running.
 */
function alphabetised<T>(value: T): T {
  if (Array.isArray(value)) return value.map(alphabetised) as unknown as T;
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = alphabetised(source[key]);
  return out as unknown as T;
}

describe('the layout (step 4, DD-002 L3)', () => {
  it('shards rules eight to a key and names the counts in the index', () => {
    const items = syncLayout(withRules(20));

    expect(items['index']).toEqual({ version: 1, rules: 20, profiles: 0 });
    expect(Object.keys(items).filter((key) => key.startsWith('rules.'))).toEqual([
      'rules.0',
      'rules.1',
      'rules.2',
    ]);
    expect((items['rules.0'] as unknown[]).length).toBe(SYNC_SHARD_SIZE);
    expect((items['rules.2'] as unknown[]).length).toBe(4);
  });

  it('writes no shard at all for an empty list, rather than one empty shard', () => {
    const items = syncLayout(withRules(0));

    expect(items['index']).toEqual({ version: 1, rules: 0, profiles: 0 });
    expect(Object.keys(items).some((key) => key.startsWith('rules.'))).toBe(false);
  });

  it('gives every other section a key of its own, in the canonical shape', () => {
    const items = syncLayout(DEFAULT_SETTINGS);

    // The same words the export file uses — one definition of what a section
    // looks like, so a reader of the store sees what a reader of a file sees.
    expect(Object.keys(items).sort()).toEqual([
      'behaviour',
      'exclusions',
      'index',
      'locale',
      'passwords',
      'sources',
      'triggers',
    ]);
    expect(items['passwords']).toEqual({
      length: DEFAULT_SETTINGS.passwords.length,
      upper: true,
      lower: true,
      digits: true,
      symbols: true,
    });
  });

  /**
   * The property the whole comparison rests on. `chrome.storage` hands objects
   * back alphabetised, so if the layout's key order came from wherever the state
   * was built rather than from the schema, the delta would call every echo a
   * change and this device would write on every sync event, forever.
   */
  it('is byte-stable across a round trip that reorders keys', () => {
    const settings = withRules(3, [profile('a', [rule('pa')])]);
    expect(JSON.stringify(syncLayout(alphabetised(settings)))).toBe(
      JSON.stringify(syncLayout(settings)),
    );
  });

  it('shards profiles on the same terms as rules', () => {
    const items = syncLayout(withRules(0, Array.from({ length: 9 }, (_, n) => profile(`p${n}`))));

    expect(items['index']).toEqual({ version: 1, rules: 0, profiles: 9 });
    expect((items['profiles.0'] as unknown[]).length).toBe(SYNC_SHARD_SIZE);
    expect((items['profiles.1'] as unknown[]).length).toBe(1);
  });
});

describe('reading the replica', () => {
  it('round-trips a configuration through the layout', () => {
    const settings = withRules(11, [profile('staging', [rule('s1'), rule('s2')])]);
    const read = readReplica(syncLayout(settings));

    expect(read.state).toBe('usable');
    if (read.state !== 'usable') return;
    expect(sameConfiguration(read.settings, settings)).toBe(true);
    expect(read.settings.rules).toHaveLength(11);
    expect(read.settings.profiles[0]?.rules).toHaveLength(2);
  });

  it('calls a store with no index empty, which is a store this device may seed', () => {
    expect(readReplica({}).state).toBe('empty');
  });

  /**
   * The sharpest case in the module, and the reason for the floor. A shard that
   * has not arrived yet and a shard that was never written look identical from
   * the key list; the counts are what tell them apart. Reading this as usable
   * means a device adopts a prefix of somebody's rule list as though it were the
   * list (A1's thin copy, BR-029-5), with both browsers reporting success.
   */
  it('refuses a replica whose index names a shard that is not there', () => {
    const items = { ...syncLayout(withRules(20)) };
    delete (items as Record<string, unknown>)['rules.2'];

    const read = readReplica(items);
    expect(read.state).toBe('incomplete');
    if (read.state !== 'incomplete') return;
    expect(read.missing).toEqual(['rules.2']);
  });

  it('refuses a replica missing a section key just as firmly as a missing shard', () => {
    const items = { ...syncLayout(withRules(2)) };
    delete (items as Record<string, unknown>)['behaviour'];

    const read = readReplica(items);
    expect(read.state).toBe('incomplete');
    if (read.state !== 'incomplete') return;
    expect(read.missing).toEqual(['behaviour']);
  });

  it('ignores a stale shard the index does not name, which is what makes set-then-prune safe', () => {
    const items = { ...syncLayout(withRules(4)), 'rules.1': [rule('ghost')] };

    const read = readReplica(items);
    expect(read.state).toBe('usable');
    if (read.state !== 'usable') return;
    expect(read.settings.rules).toHaveLength(4);
    expect(read.settings.rules.some((entry) => entry.id === 'ghost')).toBe(false);
  });

  it('reads A1’s mark before the counts, so a stopped replica is never adopted', () => {
    // The shards are complete and current — the write that failed was the *new*
    // one. Without the mark being read first this is indistinguishable from a
    // healthy replica, and another device applies a configuration the user was
    // told had stopped being carried.
    const items = { ...syncLayout(withRules(4)), ...stoppedIndex(withRules(412)) };

    const read = readReplica(items);
    expect(read.state).toBe('stopped');
    if (read.state !== 'stopped') return;
    expect(read.rules).toBe(412);
  });

  it('calls a garbled index unreadable rather than guessing at it', () => {
    expect(readReplica({ index: 'not an index' }).state).toBe('unreadable');
    expect(readReplica({ index: { rules: 'two', profiles: 0 } }).state).toBe('unreadable');
    expect(readReplica({ index: { rules: -1, profiles: 0 } }).state).toBe('unreadable');
    expect(readReplica({ index: { rules: 1.5, profiles: 0 } }).state).toBe('unreadable');
  });

  /**
   * A6. A mixed-version fleet is normal — an updated laptop beside an unupdated
   * desktop — and sync is the one foreign state that cannot be refused at a
   * boundary the way UC-026 A2 refuses a newer file: it arrives. The tolerant
   * parser keeps what this build recognises; the version travels so the screen
   * can say where the state came from.
   */
  it('reads shards from a newer schema tolerantly and names the version', () => {
    const items = {
      ...syncLayout(withRules(2)),
      index: { version: 2, rules: 2, profiles: 0 },
      behaviour: { dispatchEvents: false, somethingNewer: 42 },
    };

    const read = readReplica(items);
    expect(read.state).toBe('usable');
    if (read.state !== 'usable') return;
    expect(read.foreignVersion).toBe(2);
    expect(read.settings.behaviour.dispatchEvents).toBe(false);
    expect(read.settings.behaviour.skipHidden).toBe(DEFAULT_SETTINGS.behaviour.skipHidden);
  });

  it('contributes nothing from a shard that is not a list, rather than throwing', () => {
    const read = readReplica({ ...syncLayout(withRules(9)), 'rules.1': 'corrupt' });

    expect(read.state).toBe('usable');
    if (read.state !== 'usable') return;
    expect(read.settings.rules).toHaveLength(SYNC_SHARD_SIZE);
  });
});

describe('the delta (DD-002’s blast radius)', () => {
  /**
   * Not an optimisation. Rewriting every shard on every save would make
   * last-writer-wins apply to the whole configuration rather than to a shard of
   * it, so two devices editing different rules would destroy each other's work
   * in full instead of colliding only where they actually collided. Sharding
   * buys nothing unless the writer respects it.
   */
  it('writes only the shard an edit touched', () => {
    const before = withRules(20);
    const after: Settings = {
      ...before,
      rules: before.rules.map((entry, n) => (n === 17 ? { ...entry, label: 'edited' } : entry)),
    };

    const delta = syncDelta(syncLayout(before), syncLayout(after));
    expect(Object.keys(delta.set)).toEqual(['rules.2']);
    expect(delta.remove).toEqual([]);
  });

  it('writes nothing at all when nothing changed', () => {
    const delta = syncDelta(syncLayout(withRules(9)), syncLayout(withRules(9)));

    expect(delta.set).toEqual({});
    expect(delta.remove).toEqual([]);
  });

  /**
   * The input the real store actually produces, and the one this suite did not
   * have until `scripts/e2e-sync.mjs` supplied it. `chrome.storage.sync` returns
   * every object alphabetised at every level, so comparing the canonical form
   * against what came back called every section a change — and the damage was
   * not the writes. A save then rewrote every shard, which makes last-writer-wins
   * apply to the whole configuration rather than to eight rules of it: two
   * devices editing different rules would have destroyed each other's work in
   * full, with both screens reporting success.
   */
  it('is indifferent to the key order storage hands back', () => {
    const settings = withRules(9, [profile('a', [rule('pa')])]);
    const delta = syncDelta(alphabetised(syncLayout(settings)), syncLayout(settings));

    expect(delta.set).toEqual({});
    expect(delta.remove).toEqual([]);
  });

  /**
   * The other half of that fix, and the line it must not cross. Rule order is
   * behaviour — first match wins (FR-031) — so a delta that sorted arrays to
   * make the comparison stable would call two differently ordered rule lists
   * equal and leave the replica holding a precedence nobody chose.
   */
  it('still sees a reordering of the rules themselves as a change (FR-031)', () => {
    const settings = withRules(3);
    const swapped: Settings = { ...settings, rules: [...settings.rules].reverse() };

    expect(Object.keys(syncDelta(syncLayout(settings), syncLayout(swapped)).set)).toEqual([
      'rules.0',
    ]);
  });

  it('names the shards a shrunk list left behind, so they stop costing quota', () => {
    const delta = syncDelta(syncLayout(withRules(20)), syncLayout(withRules(4)));

    expect(delta.remove).toEqual(['rules.1', 'rules.2']);
    expect(Object.keys(delta.set).sort()).toEqual(['index', 'rules.0']);
  });
});

describe('the push plan (step 5, NFR-023)', () => {
  it('does nothing while the feature is off, and says which reason', () => {
    expect(
      planPush({ settings: withRules(3), stored: {}, prefs: DEFAULT_SYNC_PREFS, now: 1_000 }),
    ).toEqual({ do: 'nothing', why: 'disabled' });
  });

  it('does nothing while step 3 is unanswered — neither direction runs', () => {
    expect(
      planPush({
        settings: withRules(3),
        stored: {},
        prefs: prefsOn(withRules(3), { choicePending: true }),
        now: 1_000,
      }),
    ).toEqual({ do: 'nothing', why: 'choice-pending' });
  });

  it('writes immediately after a quiet period', () => {
    const plan = planPush({
      settings: withRules(3),
      stored: {},
      prefs: prefsOn(withRules(3), { lastWriteAt: 0 }),
      now: SYNC_MIN_INTERVAL_MS + 1,
    });

    expect(plan.do).toBe('write');
    if (plan.do !== 'write') return;
    expect(Object.keys(plan.set)).toContain('index');
  });

  /**
   * The gate, and the arithmetic behind it: at most two calls a flush and a
   * flush no oftener than every 72 s is 100 write operations an hour, which is
   * NFR-023's bound met by construction rather than by hoping the user types
   * slowly.
   */
  it('defers a change made inside the interval, and says how long for', () => {
    const plan = planPush({
      settings: withRules(3),
      stored: {},
      prefs: prefsOn(withRules(3), { lastWriteAt: 10_000 }),
      now: 10_000 + 12_000,
    });

    expect(plan).toEqual({ do: 'wait', forMs: SYNC_MIN_INTERVAL_MS - 12_000 });
  });

  /**
   * The answer that keeps the two directions from chasing each other. This
   * device's own write comes back as a sync change, which triggers a pull, which
   * adopts nothing — but only because the push computes its delta against what
   * the store actually holds rather than against what it assumes.
   */
  it('does nothing when the store already holds this configuration, even past the gate', () => {
    const settings = withRules(3);

    expect(
      planPush({
        settings,
        stored: syncLayout(settings),
        prefs: prefsOn(settings, { lastWriteAt: 0 }),
        now: 10 * SYNC_MIN_INTERVAL_MS,
      }),
    ).toEqual({ do: 'nothing', why: 'unchanged' });
  });

  /**
   * NFR-023 met by arithmetic rather than by hoping the user types slowly, and
   * asserted here rather than in a harness because observing it would take an
   * hour and would still only have watched one machine. A flush makes at most
   * two write calls — a `set`, and a `remove` when a shrunk list dropped a shard
   * — and DD-002 measured that the browser counts a call rather than a key.
   */
  it('is spaced so that continuous editing cannot exceed 100 write operations an hour', () => {
    const flushesPerHour = 3_600_000 / SYNC_MIN_INTERVAL_MS;

    expect(2 * flushesPerHour).toBeLessThanOrEqual(100);
  });

  it('checks for something to write before consulting the gate', () => {
    // Nothing to say is not something to wait to say. Answering `wait` here
    // would leave the screen reporting a queued change that does not exist.
    const settings = withRules(3);

    expect(
      planPush({
        settings,
        stored: syncLayout(settings),
        prefs: prefsOn(settings, { lastWriteAt: 10_000 }),
        now: 10_001,
      }),
    ).toEqual({ do: 'nothing', why: 'unchanged' });
  });
});

describe('the pull plan (step 5, BR-029-2)', () => {
  const stored: SyncItems = syncLayout(withRules(5));

  it('adopts a configuration that differs from this device’s', () => {
    const plan = planPull({ settings: withRules(2), stored, prefs: prefsOn(withRules(2)) });

    expect(plan.do).toBe('adopt');
    if (plan.do !== 'adopt') return;
    expect(plan.settings.rules).toHaveLength(5);
  });

  it('adopts nothing when the store holds what this device already has', () => {
    expect(planPull({ settings: withRules(5), stored, prefs: prefsOn(withRules(5)) })).toEqual({
      do: 'nothing',
      why: 'unchanged',
    });
  });

  it.each<readonly [string, SyncItems]>([
    ['empty', {}],
    ['unreadable', { index: 7 }],
    ['stopped', { ...stored, ...stoppedIndex(withRules(500)) }],
  ])('names %s rather than collapsing it to a boolean', (why, items) => {
    expect(planPull({ settings: withRules(2), stored: items, prefs: prefsOn(withRules(2)) })).toEqual({
      do: 'nothing',
      why,
    });
  });

  it('waits for an incomplete replica rather than applying a prefix of it', () => {
    const partial = { ...stored };
    delete (partial as Record<string, unknown>)['rules.0'];

    expect(planPull({ settings: withRules(2), stored: partial, prefs: prefsOn(withRules(2)) })).toEqual({
      do: 'nothing',
      why: 'incomplete',
    });
  });

  /**
   * Without this the rate gate becomes a way to lose the user's work. An edit
   * made inside the gate is held locally while the push waits, and any sync
   * event in that window — another device's write, or this device's own previous
   * write echoing back — finds a replica that differs from local and adopts it,
   * silently reverting the edit that was just made. The screen then reports that
   * a configuration arrived, which is true, and says nothing about what it
   * replaced. Found by `scripts/e2e-sync.mjs`: every plan passed on its own, and
   * what was wrong was the order two of them ran in.
   */
  it('adopts nothing while local holds a change the store has not seen', () => {
    // Agreed on a two-rule state; local is now three. Whatever the store holds,
    // this device has something unsent and the push goes first.
    expect(
      planPull({ settings: withRules(3), stored, prefs: prefsOn(withRules(2)) }),
    ).toEqual({ do: 'nothing', why: 'local-newer' });
  });

  it('adopts once local matches what it last agreed on, so deferring is not refusing', () => {
    expect(planPull({ settings: withRules(2), stored, prefs: prefsOn(withRules(2)) }).do).toBe(
      'adopt',
    );
  });

  /**
   * Why this is asked of state and not of the pending flag. The flag is raised
   * by the settings-change handler, which runs *after* the local write it is
   * reacting to, so a pull queued by an earlier sync event runs in between and
   * sees a configuration already newer than the store with nothing marking it.
   * The fingerprint is true the moment the write lands rather than the moment
   * something notices — which is the difference between a guard and a race.
   */
  it('defers on the state alone, with no pending flag raised yet', () => {
    expect(
      planPull({ settings: withRules(3), stored, prefs: prefsOn(withRules(2), { pending: false }) }),
    ).toEqual({ do: 'nothing', why: 'local-newer' });
  });

  it('defers on a device that has never agreed with the store about anything', () => {
    expect(planPull({ settings: withRules(2), stored, prefs: { ...DEFAULT_SYNC_PREFS, enabled: true } })).toEqual({
      do: 'nothing',
      why: 'local-newer',
    });
  });

  it('runs in neither direction while the feature is off or step 3 is unanswered', () => {
    expect(planPull({ settings: withRules(2), stored, prefs: DEFAULT_SYNC_PREFS })).toEqual({
      do: 'nothing',
      why: 'disabled',
    });
    expect(
      planPull({ settings: withRules(2), stored, prefs: prefsOn(withRules(2), { choicePending: true }) }),
    ).toEqual({ do: 'nothing', why: 'choice-pending' });
  });
});

describe('telling a ceiling from every other refusal', () => {
  /**
   * Getting this wrong in the safe direction reports a quota stop as an
   * unexplained refusal, which is still true and still actionable. Getting it
   * wrong the other way tells a user to delete rules over a store that was
   * merely being written to quickly.
   */
  it.each([
    'Resource::kQuotaBytes quota exceeded',
    'Resource::kQuotaBytesPerItem quota exceeded',
    'QUOTA_BYTES quota exceeded',
    // Firefox's wording, measured 2026-08-28 by installing a probe add-on in a
    // real Gecko and exceeding both quotas — not transcribed from its
    // documentation. It is the same sentence for the per-item and the total
    // refusal, which is why this classifier asks whether a refusal *was* the
    // ceiling rather than which ceiling it was.
    'QuotaExceededError: storage.sync API call exceeded its quota limitations.',
  ])('reads %s as the ceiling', (reason) => {
    expect(isQuotaFailure(reason)).toBe(true);
  });

  it.each([
    'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.',
    'This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.',
    'Sync is disabled',
    '',
  ])('does not read %s as the ceiling', (reason) => {
    expect(isQuotaFailure(reason)).toBe(false);
  });
});

describe('what step 3 shows', () => {
  it('counts both sides', () => {
    expect(syncSides(withRules(31, [profile('a'), profile('b')]), withRules(12))).toEqual({
      here: { rules: 31, profiles: 2 },
      there: { rules: 12, profiles: 0 },
    });
  });

  /**
   * One definition of "are these the same", shared with `planPull`. Two would be
   * how a screen comes to offer a choice between two identical configurations —
   * or, worse, adopt over a difference the screen said was not there.
   */
  it('agrees with the pull plan about what a difference is', () => {
    const settings = withRules(4);
    const reordered = alphabetised(settings);

    expect(sameConfiguration(settings, reordered)).toBe(true);
    expect(
      planPull({ settings, stored: syncLayout(reordered), prefs: prefsOn(settings) }),
    ).toEqual({ do: 'nothing', why: 'unchanged' });
  });
});

describe('what wakes the engine', () => {
  const at = (patch: Partial<SyncPrefs> = {}) => ({ ...DEFAULT_SYNC_PREFS, ...patch });

  /**
   * The engine writes the preferences and also wakes on them, so without this
   * question the two are a loop. What that loop produced when it was built was
   * not a busy worker but a lying screen: a re-entrant flush ran inside the
   * outer one's await, read the write time the outer one had just claimed, and
   * reported the change as queued — leaving a correctly written replica behind a
   * status line that said it was still waiting, permanently. Found by
   * `scripts/e2e-sync.mjs`; the unit suite had every operation passing on its
   * own, which is the tier distinction this project keeps rediscovering.
   */
  it.each([
    ['synchronisation switched on', at(), at({ enabled: true })],
    ['step 3 answered', at({ enabled: true, choicePending: true }), at({ enabled: true })],
  ])('wakes on %s — the two transitions that are a user deciding something', (_what, before, after) => {
    expect(wakesEngine(before, after)).toBe(true);
  });

  it.each([
    ['a claimed write time', at({ enabled: true }), at({ enabled: true, lastWriteAt: 1_000 })],
    [
      'an outcome being recorded',
      at({ enabled: true, pending: true }),
      at({ enabled: true, pending: true, outcome: { kind: 'waiting' } }),
    ],
    [
      'a pending flag being cleared after a write',
      at({ enabled: true, pending: true }),
      at({ enabled: true, outcome: { kind: 'written' } }),
    ],
    ['synchronisation switched off', at({ enabled: true }), at()],
  ])('does not wake on %s — a record is not an instruction', (_what, before, after) => {
    expect(wakesEngine(before, after)).toBe(false);
  });

  /**
   * The second half of the same lesson, and the one that cost a correct screen.
   * A raised pending flag looks like work — it is the statement that there is
   * something to send — but the only thing that raises it is the settings-change
   * handler, which flushes for itself in the same queued step. Waking on it too
   * ran a second flush behind the first, inside the write time the first had
   * just claimed, so it reported the change as queued; on the ceiling path that
   * replaced a stop the user had to act on with a reassuring sentence about a
   * queue, a second after it appeared. Found by `scripts/e2e-sync.mjs`.
   */
  it('does not wake on a pending flag alone, because the handler that raises it flushes', () => {
    expect(wakesEngine(at({ enabled: true }), at({ enabled: true, pending: true }))).toBe(false);
  });

  it('still wakes on every user decision that raises the flag, so nothing is lost', () => {
    // `enable` and `chooseHere` both raise pending, and both flip one of the two
    // fields above in the same write — which is why not watching pending costs
    // nothing.
    expect(wakesEngine(at(), at({ enabled: true, pending: true }))).toBe(true);
    expect(
      wakesEngine(at({ enabled: true, choicePending: true }), at({ enabled: true, pending: true })),
    ).toBe(true);
  });

  it('treats an absent previous value as the shipped state rather than throwing', () => {
    expect(wakesEngine(undefined, at({ enabled: true }))).toBe(true);
    expect(wakesEngine(undefined, undefined)).toBe(false);
  });
});

describe('what a queued retry is allowed to say (BR-029-6)', () => {
  /**
   * A queued retry is not news that supersedes a failure. The ceiling and a
   * refusal are the two outcomes the user has something to *do* about, and both
   * are reached with the change still pending — so the very next flush is inside
   * the gate and would otherwise paint "a change is queued, it will go shortly"
   * over them. True, and the wrong thing to say: it reads as progress, which is
   * the reassuring direction this screen is not allowed to drift in.
   */
  it.each([
    ['the ceiling', { kind: 'stopped', rules: 900 }],
    ['a refusal', { kind: 'refused', reason: 'Sync is disabled' }],
    // Not about this store at all: a queue sentence is no more relevant to a
    // local write failure than it is to a ceiling.
    ['an arrival that could not be saved here', { kind: 'arrival-unsaved', reason: 'QuotaExceededError' }],
  ] as const)('leaves %s standing', (_what, outcome) => {
    expect(outcomeWhileWaiting(outcome)).toBeUndefined();
  });

  it.each([
    ['nothing yet', { kind: 'idle' }],
    ['a previous write', { kind: 'written' }],
    ['a previous arrival', { kind: 'adopted' }],
    // Stale by construction: reaching a wait means the store was just read
    // successfully to plan against, so leaving a read failure up would be this
    // function's own failure in the other direction.
    ['a read failure that has since succeeded', { kind: 'unreadable', reason: 'gone' }],
  ] as const)('replaces %s, which the user has nothing to do about', (_what, outcome) => {
    expect(outcomeWhileWaiting(outcome)).toEqual({ kind: 'waiting' });
  });

  it('does not rewrite a wait that is already on screen', () => {
    expect(outcomeWhileWaiting({ kind: 'waiting' })).toBeUndefined();
  });
});

describe('whether there is anything to send (the adoption echo)', () => {
  /**
   * The case the question exists for. Adopting an arrival writes local settings
   * like any other change, so without asking this the device marked a push
   * pending over a configuration it had just been *given* — and in the window
   * where a third device wrote in between, what that push sent was a revert of
   * that device's change, with a reach set by how far two configurations differ
   * rather than by the shard size the screen promises.
   */
  it('says there is nothing to send about a configuration just adopted', () => {
    const adopted = withRules(5);

    expect(hasUnsentChange(adopted, prefsOn(adopted))).toBe(false);
  });

  it('says there is something to send about an edit made here', () => {
    expect(hasUnsentChange(withRules(6), prefsOn(withRules(5)))).toBe(true);
  });

  it('says there is something to send on a device that has never agreed with the store', () => {
    expect(hasUnsentChange(withRules(5), { ...DEFAULT_SYNC_PREFS, enabled: true })).toBe(true);
  });

  /**
   * An edit and its exact reversal leave nothing to send, which is right rather
   * than merely convenient: the store already holds what local now holds.
   */
  it('says there is nothing to send when an edit has been undone back to the stored state', () => {
    const original = withRules(5);
    const prefs = prefsOn(original);

    expect(hasUnsentChange(withRules(6), prefs)).toBe(true);
    expect(hasUnsentChange(original, prefs)).toBe(false);
  });

  it('is indifferent to the key order storage hands back, like every other comparison here', () => {
    const settings = withRules(4, [profile('a', [rule('pa')])]);

    expect(hasUnsentChange(alphabetised(settings), prefsOn(settings))).toBe(false);
  });
});

describe('the fingerprint', () => {
  it('is the same for two states that differ only in the key order storage returns', () => {
    const settings = withRules(4, [profile('a', [rule('pa')])]);

    expect(settingsFingerprint(alphabetised(settings))).toBe(settingsFingerprint(settings));
  });

  it('changes for a change too small to see', () => {
    const settings = withRules(4);
    const nudged: Settings = {
      ...settings,
      rules: settings.rules.map((entry, n) => (n === 2 ? { ...entry, enabled: false } : entry)),
    };

    expect(settingsFingerprint(nudged)).not.toBe(settingsFingerprint(settings));
  });

  it('changes when the rules are only reordered, because order is behaviour (FR-031)', () => {
    const settings = withRules(3);

    expect(settingsFingerprint({ ...settings, rules: [...settings.rules].reverse() })).not.toBe(
      settingsFingerprint(settings),
    );
  });

  it('is short enough to sit in the preferences beside the settings, not a second copy of them', () => {
    expect(settingsFingerprint(withRules(400)).length).toBeLessThan(40);
  });
});

describe('the preferences (BR-029-1)', () => {
  it('ship with synchronisation off', () => {
    expect(DEFAULT_SYNC_PREFS.enabled).toBe(false);
  });

  /**
   * The toggle is deliberately not part of `Settings`, which is what keeps it
   * out of the replica, the export file, an import and a restore. A toggle that
   * travelled would switch synchronisation off everywhere the moment one device
   * opted out — the single-key conflict wearing a settings-screen face.
   */
  it('is nowhere in the layout, so it cannot travel', () => {
    const keys = Object.keys(syncLayout(withRules(2)));

    expect(keys).not.toContain('sync');
    expect(JSON.stringify(syncLayout(withRules(2)))).not.toContain('choicePending');
  });
});
