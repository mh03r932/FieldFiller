/**
 * The background ↔ page-agent message protocol.
 *
 * Phase 0 defines only the liveness probe. The fill protocol proper — field
 * descriptors out, values plus provenance back, one round trip per fill
 * (DD-003, NFR-029, NFR-030) — lands here in Phase 1, alongside the walk.
 *
 * This module is platform-free by construction: no `chrome.*`, no `browser.*`,
 * no DOM. Both sides of the boundary may import it (NFR-015).
 */

/** A message from the background to a page agent in one frame. */
export type ToAgentMessage = {
  readonly kind: 'ping';
};

/** A page agent's reply. */
export type FromAgentMessage = {
  readonly kind: 'pong';
  /** The frame's own URL, for correlating replies in a multi-frame fill. */
  readonly frameUrl: string;
};

export const PING: ToAgentMessage = { kind: 'ping' };

/**
 * Narrows an untrusted `unknown` from the messaging channel. Extension messages
 * arrive untyped and a page cannot send them, but the background must still not
 * assume shape — a stale agent from a previous extension version can.
 */
export function isToAgentMessage(value: unknown): value is ToAgentMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'ping'
  );
}
