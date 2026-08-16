import { describe, expect, it } from 'vitest';
import { isFromAgentMessage, isToAgentMessage, isValuesResponse, PING } from '@/lib/protocol';

/**
 * Phase 0's only unit test. Its job is less to prove `isToAgentMessage` correct
 * than to prove the test path exists and runs in CI before there is anything
 * substantial to test — ND-14 identifies the absence of return types as why the
 * reference has no tests, and an unused test harness rots the same way.
 */
describe('isToAgentMessage', () => {
  it('accepts the ping message', () => {
    expect(isToAgentMessage(PING)).toBe(true);
  });

  it.each(['menu', 'shortcut', 'toolbar'])('accepts a fill instruction from %s', (trigger) => {
    expect(
      isToAgentMessage({
        kind: 'fill',
        operationId: 'op-1',
        scope: 'all-inputs',
        trigger,
        settings: { dispatchEvents: true },
      }),
    ).toBe(true);
  });

  it.each([
    ['no trigger at all', undefined],
    ['a trigger this version does not know', 'telepathy'],
    ['a trigger of the wrong type', 3],
  ])('rejects a fill instruction with %s', (_label, trigger) => {
    // The trigger decides whether the anchor is the element under the pointer or
    // the one holding focus. Guessing is the defect the field was added to fix,
    // so an instruction that does not name one is not actionable — the
    // background's timeout clears it, which is cheaper than a form filled
    // somewhere the user was not looking.
    expect(
      isToAgentMessage({
        kind: 'fill',
        operationId: 'op-1',
        scope: 'all-inputs',
        trigger,
        settings: { dispatchEvents: true },
      }),
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ping'],
    ['an unknown kind', { kind: 'defenestrate' }],
    ['an object with no kind', { frameUrl: 'https://example.test/' }],
  ])('rejects %s', (_label, value) => {
    expect(isToAgentMessage(value)).toBe(false);
  });

  it('rejects a message from a future protocol version without throwing', () => {
    // A page agent left over from a previous extension version is the realistic
    // source of an unexpected shape, and the background must narrow rather than
    // assume — it cannot assume both halves were updated together.
    expect(isToAgentMessage({ kind: 'ping', unexpected: { nested: [1] } })).toBe(true);
    expect(isToAgentMessage({ kind: ['ping'] })).toBe(false);
  });
});

/**
 * The other direction, and the one that carries structure rather than a tag.
 *
 * This is the trust boundary the whole message contract exists for. The agent is
 * our own code but not necessarily our own *version*: a tab opened before an
 * update runs the previous build until it reloads, so every field the background
 * reads downstream has to be established here or not at all. These tests were
 * added 2026-08-15 when the coverage-scope gate found `protocol.ts` measured by
 * coverage, gated by nothing, and sitting at 22% lines.
 */
describe('isFromAgentMessage', () => {
  const descriptor = { ref: 1, kind: 'text', sources: {}, constraints: {} };
  const report = { frame: 'f1', frameUrl: 'https://example.test/', outcomes: [] };

  it('accepts each message the agent sends', () => {
    expect(isFromAgentMessage({ kind: 'pong', frameUrl: 'https://example.test/' })).toBe(true);
    expect(isFromAgentMessage({ kind: 'accepted', frame: 'f1' })).toBe(true);
    expect(isFromAgentMessage({ kind: 'joined', operationId: 'op-1', frame: 'f1' })).toBe(true);
    expect(
      isFromAgentMessage({ kind: 'descriptors', operationId: 'op-1', descriptors: [descriptor] }),
    ).toBe(true);
    expect(isFromAgentMessage({ kind: 'report', operationId: 'op-1', report })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'report'],
    ['an unknown kind', { kind: 'apologise' }],
    ['a pong with no frame url', { kind: 'pong' }],
    ['a joined with no operation', { kind: 'joined', frame: 'f1' }],
  ])('rejects %s', (_label, value) => {
    expect(isFromAgentMessage(value)).toBe(false);
  });

  it('rejects a descriptor list where one entry is malformed', () => {
    // Every entry, not just the array. One bad descriptor among good ones is the
    // shape a partial version mismatch actually produces, and accepting the
    // message would push the problem to whatever reads `ref` downstream.
    expect(
      isFromAgentMessage({
        kind: 'descriptors',
        operationId: 'op-1',
        descriptors: [descriptor, { ref: 'two', kind: 'text', sources: {}, constraints: {} }],
      }),
    ).toBe(false);
    expect(
      isFromAgentMessage({ kind: 'descriptors', operationId: 'op-1', descriptors: descriptor }),
    ).toBe(false);
  });

  it('rejects a descriptor whose sources or constraints are null', () => {
    // `typeof null === 'object'`, which is exactly why the guard checks for null
    // separately and why this test exists to keep it there.
    expect(
      isFromAgentMessage({
        kind: 'descriptors',
        operationId: 'op-1',
        descriptors: [{ ref: 1, kind: 'text', sources: null, constraints: {} }],
      }),
    ).toBe(false);
    expect(
      isFromAgentMessage({
        kind: 'descriptors',
        operationId: 'op-1',
        descriptors: [{ ref: 1, kind: 'text', sources: {}, constraints: null }],
      }),
    ).toBe(false);
  });

  it('rejects a report carrying an outcome status this version does not know', () => {
    expect(
      isFromAgentMessage({
        kind: 'report',
        operationId: 'op-1',
        report: { ...report, outcomes: [{ ref: 1, status: 'deferred' }] },
      }),
    ).toBe(false);
  });

  it('accepts a report from an agent built before DD-009 added the loop fields', () => {
    // The compatibility claim in the guard's own comment. A tab that has not
    // reloaded since the update sends no `passes`, `capped` or `stale`, and its
    // report must still validate — as the single-pass fill it is.
    expect(isFromAgentMessage({ kind: 'report', operationId: 'op-1', report })).toBe(true);
    expect(
      isFromAgentMessage({
        kind: 'report',
        operationId: 'op-1',
        report: { ...report, passes: 3, capped: 'time-budget', stale: 2 },
      }),
    ).toBe(true);
  });

  it('rejects a report whose loop fields are present but wrong', () => {
    // Present-and-wrong is the case optional checking is easy to get wrong: a
    // guard that only tests `!== undefined` on one field lets the others through.
    for (const wrong of [{ passes: 'three' }, { capped: 'bored' }, { stale: [] }]) {
      expect(
        isFromAgentMessage({ kind: 'report', operationId: 'op-1', report: { ...report, ...wrong } }),
      ).toBe(false);
    }
  });
});

describe('isValuesResponse', () => {
  it('accepts a values response and rejects everything else', () => {
    expect(isValuesResponse({ kind: 'values', values: [] })).toBe(true);
    expect(isValuesResponse({ kind: 'values', values: [{ ref: 1, value: 'x' }] })).toBe(true);
    expect(isValuesResponse({ kind: 'values' })).toBe(false);
    expect(isValuesResponse({ kind: 'report', values: [] })).toBe(false);
    expect(isValuesResponse(null)).toBe(false);
  });
});

describe('validating the DD-008 fields at the boundary', () => {
  const frame = (extra: Record<string, unknown>): unknown => ({
    kind: 'report',
    operationId: 'op-1',
    report: { frame: 'top', frameUrl: 'https://x.test/', outcomes: [], ...extra },
  });

  it('accepts a report from an agent that predates the scopes', () => {
    // Neither field is sent by a build from before DD-008, and a tab open across
    // the update still runs one. Absent stays valid; that is what makes the
    // protocol able to grow.
    expect(isFromAgentMessage(frame({}))).toBe(true);
  });

  it.each([
    ['refused', 'no-anchor'],
    ['refused', 'no-form-around-anchor'],
    ['scopeRule', 'element-form'],
    ['scopeRule', 'anchor-control'],
  ])('accepts a known %s value: %s', (field, value) => {
    expect(isFromAgentMessage(frame({ [field]: value }))).toBe(true);
  });

  it.each([
    ['refused', 'no-idea'],
    ['refused', 7],
    ['scopeRule', 'vibes'],
    ['scopeRule', {}],
  ])('rejects an unknown %s value: %s', (field, value) => {
    // Both reach a user-facing surface — `refused` decides which sentence is
    // shown and `scopeRule` names a rung out loud — so an unrecognised value
    // would be displayed, or would silently change what is displayed.
    expect(isFromAgentMessage(frame({ [field]: value }))).toBe(false);
  });
});
