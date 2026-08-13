import { describe, expect, it } from 'vitest';
import { isToAgentMessage, PING } from '@/lib/protocol';

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

  it('accepts a fill instruction', () => {
    expect(
      isToAgentMessage({
        kind: 'fill',
        operationId: 'op-1',
        scope: 'all-inputs',
        settings: { dispatchEvents: true },
      }),
    ).toBe(true);
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
