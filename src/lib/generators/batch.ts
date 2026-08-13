import type { FieldDescriptor, FieldValue } from '../protocol';
import type { Persona, Random } from '../persona/persona';
import { generateValue } from './default-generator';

/**
 * Generates values for one frame's descriptor batch.
 *
 * Lives here rather than in the background entrypoint so it can be tested
 * without an extension host (NFR-015) — which matters more than usual, because
 * the property it protects is only visible across a *set* of descriptors and is
 * invisible in any single one.
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
export function generateBatch(
  descriptors: readonly FieldDescriptor[],
  persona: Persona,
  random: Random,
): FieldValue[] {
  const byGroup = new Map<string, FieldValue>();

  return descriptors.map((descriptor) => {
    const group = descriptor.group;
    if (group === undefined) return generateValue(descriptor, persona, random);

    const decided = byGroup.get(group);
    // Generated once for the group and handed to every member; each ticks itself
    // only if it holds the chosen value, so exactly one does.
    const value = decided ?? generateValue(descriptor, persona, random);
    if (decided === undefined) byGroup.set(group, value);

    return { ...value, ref: descriptor.ref };
  });
}
