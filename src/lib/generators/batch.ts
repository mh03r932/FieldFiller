import type { FieldDescriptor, FieldValue } from '../protocol';
import { seededRandom, type Persona, type Random } from '../persona/persona';
import { generateValue } from './default-generator';

/**
 * Generates values for one frame's descriptor batch.
 *
 * Lives here rather than in the background entrypoint so it can be tested
 * without an extension host (NFR-015) — which matters more than usual, because
 * both properties it protects are only visible across a *set* of descriptors,
 * or across a *sequence* of batches, and neither is visible in any single one.
 *
 * Radios are decided per group, not per element. Every member carries the whole
 * group's options, so generating per descriptor makes each radio pick
 * independently. Applying a choice to a radio means "tick me if I hold the
 * chosen value", so members that choose each other tick nothing at all: for a
 * two-option group that is a quarter of all fills, and larger groups fail at
 * (1 − 1/n)^n.
 *
 * The group token comes from the agent, the only side that can resolve real
 * membership through the owning form — two forms may use the same `name` for
 * unrelated groups (BR-005-3).
 */
export type BatchSource = {
  readonly persona: Persona;
  /**
   * The random source for one control, keyed by its token (FR-080).
   *
   * A control the page makes us write twice must receive the same value both
   * times. Drawing from one stateful stream cannot do that: a control described
   * again in a later pass would take the *next* value from the stream, so an
   * email refilled in pass 2 would stop matching the "confirm email" filled in
   * pass 1 — and FR-024 would be broken by the loop itself, on exactly the pages
   * where it is hardest to notice (BR-034-3).
   */
  readonly randomFor: (token: string | undefined) => Random;
};

export function generateBatch(
  descriptors: readonly FieldDescriptor[],
  source: BatchSource,
): FieldValue[] {
  const byGroup = new Map<string, FieldValue>();

  return descriptors.map((descriptor) => {
    const group = descriptor.group;
    if (group === undefined) {
      return generateValue(descriptor, source.persona, source.randomFor(descriptor.token));
    }

    const decided = byGroup.get(group);
    // Generated once for the group and handed to every member; each ticks itself
    // only if it holds the chosen value, so exactly one does. Seeded from the
    // group's token rather than any one member's, so the group keeps its answer
    // across passes for the same reason a single control keeps its value.
    const value = decided ?? generateValue(descriptor, source.persona, source.randomFor(group));
    if (decided === undefined) byGroup.set(group, value);

    return { ...value, ref: descriptor.ref };
  });
}

/**
 * A random stream for one control, derived from the operation's seed and the
 * control's token.
 *
 * Deterministic in both, which is what makes it idempotent within a fill and
 * still fresh across fills (FR-075): the token is stable for the operation, and
 * the seed is new for every fill. FNV-1a because it is four lines and mixes a
 * short token well enough for dummy data; nothing here is security-bearing.
 */
export function tokenRandom(seed: number, token: string): Random {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return seededRandom((hash ^ seed) >>> 0);
}
