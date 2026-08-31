import { describe, expect, it, vi } from 'vitest';
import { createOperations, type Clock } from '../src/entrypoints/background/operations';
import type {
  FieldDescriptor,
  FieldOutcome,
  FillReport,
  FrameReport,
  FrameToken,
} from '@/lib/protocol';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { compileRules } from '@/lib/rules/match';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { BehaviourDefaults } from '@/lib/generators/default-generator';

/**
 * The operation registry's timing decisions, exercised with a fake clock.
 *
 * This is what the registry's injected `Clock` exists for (NFR-015): the join
 * window, the settle scheduling, the sliding timeout and the abandon-after
 * backstop were testable only end-to-end before the background was split, and
 * the split's one behavioural regression — an unanswered `descriptors` request
 * holding the message channel open — lived exactly at that untested boundary.
 * Every test here drives the registry through its public surface only, the way
 * the router does.
 */

/** A deterministic clock: `advance` runs timers in due order, re-arming included. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly run: () => void; readonly at: number }>();

  const clock: Clock = {
    setTimeout: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { run: callback, at: now + ms });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    now: () => now,
  };

  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      // Re-snapshotted every iteration: a callback may arm or clear timers,
      // which is the sliding timeout's whole behaviour.
      let due: [number, { run: () => void; at: number }] | undefined;
      for (const entry of timers) {
        if (entry[1].at > target) continue;
        if (due === undefined || entry[1].at < due[1].at) due = entry;
      }
      if (due === undefined) break;
      now = Math.max(now, due[1].at);
      timers.delete(due[0]);
      due[1].run();
    }
    now = target;
  };

  return { clock, advance, pending: (): number => timers.size };
}

const DESCRIPTOR: FieldDescriptor = {
  ref: 0,
  token: 'token-0',
  kind: 'text',
  sources: { name: 'given_name', label: 'Given name' },
  constraints: {},
};

/** One assembled operation, the shape `startFill` hands the registry. */
function base(tabId: number, started: number) {
  const random = seededRandom(42);
  const defaults: BehaviourDefaults = {
    consentKeywords: DEFAULT_SETTINGS.behaviour.consentKeywords,
    confirmationKeywords: DEFAULT_SETTINGS.behaviour.confirmationKeywords,
    maxLengths: DEFAULT_SETTINGS.behaviour.maxLengths,
  };
  return {
    persona: createPersona(random, 'en-US'),
    random,
    seed: 42,
    tabId,
    outcomes: { filled: 0, skipped: 0, failed: 0 },
    joined: new Set<FrameToken>(),
    frames: new Set<FrameToken>(),
    started,
    notes: new Map(),
    fields: [],
    scope: 'all-inputs' as const,
    rules: compileRules([], DEFAULT_SETTINGS.sources),
    defaults,
    profile: undefined,
    skippedRules: new Set<string>(),
    matchCostMs: new Map<string, number>(),
    excludeCostMs: new Map<string, number>(),
    skippedExclusions: [],
  };
}

/** A frame's report carrying exactly the outcomes given. */
function reportFrom(frame: FrameToken, outcomes: readonly FieldOutcome[]): FrameReport {
  return { frame, frameUrl: 'https://frame.test/', outcomes };
}

function registry() {
  const { clock, advance, pending } = fakeClock();
  const completions: FillReport[] = [];
  const operations = createOperations({
    clock,
    onCompleted: ({ report }) => {
      completions.push(report);
    },
  });
  return { operations, clock, advance, pending, completions };
}

describe('the operation registry', () => {
  it('claims a tab once and only once until the operation finishes', () => {
    const { operations } = registry();
    expect(operations.claimTab(7)).toBe(true);
    expect(operations.claimTab(7)).toBe(false);

    operations.register('op-1', base(7, 0));
    operations.finish('op-1', 7);
    expect(operations.claimTab(7)).toBe(true);
  });

  it('holds a report that arrived inside the join window until the window has passed', () => {
    const { operations, advance, pending, completions } = registry();
    operations.register('op-1', base(3, 0));
    operations.claimTab(3);

    // A frame can report before a slower sibling has even joined: the frame's
    // report at t=10 must not close the operation while the window (t=300) is
    // still open.
    operations.joined({ kind: 'joined', operationId: 'op-1', frame: 'frame-a' });
    operations.report({
      kind: 'report',
      operationId: 'op-1',
      report: reportFrom('frame-a', [{ ref: 0, status: 'filled', provenance: 'built-in' }]),
    });
    expect(completions.length).toBe(0);

    advance(300);
    expect(completions.length).toBe(1);
    expect(completions[0]!.counts).toEqual({ filled: 1, skipped: 0, failed: 0 });
    // Held before the badge would be drawn, and finished after: nothing armed.
    expect(pending()).toBe(0);
  });

  it('closes without a joined frame that goes silent, once abandon-after has elapsed', () => {
    const { operations, advance, completions } = registry();
    operations.register('op-1', base(3, 0));
    operations.claimTab(3);

    operations.joined({ kind: 'joined', operationId: 'op-1', frame: 'frame-a' });
    operations.joined({ kind: 'joined', operationId: 'op-1', frame: 'frame-b' });
    operations.report({
      kind: 'report',
      operationId: 'op-1',
      report: reportFrom('frame-a', [{ ref: 0, status: 'filled', provenance: 'built-in' }]),
    });

    // The window closes at t=300, but frame-b was last heard from at t=0: not
    // yet abandoned, only re-checked. Abandon-after is measured from the last
    // sign of life, never from the start.
    advance(300);
    expect(completions.length).toBe(0);

    advance(2500);
    expect(completions.length).toBe(1);
    expect(completions[0]!.counts).toEqual({ filled: 1, skipped: 0, failed: 0 });
  });

  it('slides the operation timeout on descriptors, and abandons quietly at the deadline', () => {
    const { operations, advance, completions } = registry();
    operations.register('op-1', base(3, 0));
    operations.claimTab(3);

    const respond = vi.fn();
    // Progress at t=14000: the original deadline (t=15000) is cleared and
    // re-armed from the last sign of life.
    advance(14000);
    expect(
      operations.descriptors(
        { kind: 'descriptors', operationId: 'op-1', frame: 'frame-a', descriptors: [DESCRIPTOR] },
        respond,
      ),
    ).toBe(true);

    advance(1000);
    expect(completions.length).toBe(0); // the original deadline no longer fires

    advance(15000);
    expect(completions.length).toBe(0); // abandoned, not completed: no report exists
    // The operation is gone, not merely quiet — a later request for it is the
    // unknown-operation path and must close the channel.
    expect(
      operations.descriptors(
        { kind: 'descriptors', operationId: 'op-1', frame: 'frame-a', descriptors: [DESCRIPTOR] },
        vi.fn(),
      ),
    ).toBe(false);
  });

  it('closes the channel on an unanswered descriptors request for an unknown operation', () => {
    const { operations } = registry();
    const respond = vi.fn();

    // The eviction-restart case: the worker holding the persona is gone, and
    // this request names an id nobody holds. The registry must say it did not
    // answer, so the router lets the channel close and the agent's un-timed
    // await resolves `undefined` as `values-unavailable` — holding it open is a
    // silent stall until the worker is evicted.
    expect(
      operations.descriptors(
        { kind: 'descriptors', operationId: 'gone', frame: 'frame-a', descriptors: [DESCRIPTOR] },
        respond,
      ),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('answers a descriptors request for a live operation and returns the values', () => {
    const { operations } = registry();
    operations.register('op-1', base(3, 0));
    operations.claimTab(3);

    const respond = vi.fn();
    expect(
      operations.descriptors(
        { kind: 'descriptors', operationId: 'op-1', frame: 'frame-a', descriptors: [DESCRIPTOR] },
        respond,
      ),
    ).toBe(true);
    expect(respond).toHaveBeenCalledTimes(1);
    const answer = respond.mock.calls[0]![0] as { kind: string; values: { ref: number }[] };
    expect(answer.kind).toBe('values');
    expect(answer.values.map((value) => value.ref)).toEqual([0]);
  });

  it('swallows joined and report messages for an unknown operation without throwing', () => {
    const { operations } = registry();
    expect(() =>
      operations.joined({ kind: 'joined', operationId: 'gone', frame: 'frame-a' }),
    ).not.toThrow();
    expect(() =>
      operations.report({
        kind: 'report',
        operationId: 'gone',
        report: reportFrom('frame-a', []),
      }),
    ).not.toThrow();
  });

  it('counts a duplicate frame report once, keyed on the frame token', () => {
    const { operations, advance, completions } = registry();
    operations.register('op-1', base(3, 0));
    operations.claimTab(3);
    operations.joined({ kind: 'joined', operationId: 'op-1', frame: 'frame-a' });

    const outcome: FieldOutcome = { ref: 0, status: 'filled', provenance: 'built-in' };
    operations.report({ kind: 'report', operationId: 'op-1', report: reportFrom('frame-a', [outcome]) });
    operations.report({ kind: 'report', operationId: 'op-1', report: reportFrom('frame-a', [outcome]) });

    advance(300);
    expect(completions.length).toBe(1);
    expect(completions[0]!.counts).toEqual({ filled: 1, skipped: 0, failed: 0 });
  });
});
