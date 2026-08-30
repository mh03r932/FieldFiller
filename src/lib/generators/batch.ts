import type { FieldDescriptor, FieldValue } from '../protocol';
import { seededRandom, type Persona, type Random } from '../persona/persona';
import {
  constrain,
  generateValue,
  mirrorsAnotherField,
  type BehaviourDefaults,
} from './default-generator';
import { selectRule, type CompiledRule, type MatchCost } from '../rules/match';
import { applyToControl, generateRuleText } from '../rules/generate';

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
  /**
   * The user's rules, compiled once for the whole fill (NFR-025, ND-15).
   *
   * Ordered by precedence: the active profile's rules ahead of the global list,
   * so first-match-wins is the whole of FR-031. Empty — the default — means the
   * engine behaves exactly as it did before rules existed.
   */
  readonly rules?: readonly CompiledRule[] | undefined;
  /**
   * A clock, where the caller wants matching measured (NFR-032).
   *
   * Injected rather than reached for, exactly as `randomFor` is: this module is
   * testable without a host (NFR-015), and the bound is then testable against a
   * fake clock rather than against a machine that has to genuinely be slow.
   * Absent means no measuring and no cost — which is what the unit suite wants
   * of the several hundred calls that ask what a rule matched rather than what
   * it cost.
   */
  readonly now?: (() => number) | undefined;
  /**
   * The configurable behaviour defaults (UC-022).
   *
   * Optional, so a test that cares about rules or grouping says nothing about
   * keywords or length caps and gets what the extension ships.
   */
  readonly defaults?: BehaviourDefaults | undefined;
};

export type BatchResult = {
  readonly values: readonly FieldValue[];
  /**
   * Rules that could not run, by label, with the reason.
   *
   * Reported rather than swallowed (DD-005): the field still gets filled by the
   * generator behind the rule, and the user is told which rule stopped working.
   * A rule that silently does nothing is the reference's behaviour and one of
   * the defects this project names.
   */
  readonly skippedRules: readonly string[];
  /**
   * What this batch's matching cost, rule by rule, in milliseconds (NFR-032).
   *
   * Beside `skippedRules` and for the same reason: both are facts about the
   * *configuration* that only a whole fill can see, and both name a rule the
   * user can go and fix. A slow rule is slow against every control, so this is
   * emphatically not a per-field report — five hundred identical lines about one
   * deletable rule would bury the one thing worth reading.
   *
   * Empty on every ordinary fill. Matching 500 controls against an ordinary rule
   * is well under a millisecond in total; the pattern this exists for costs
   * 287 ms against *one*.
   *
   * Milliseconds rather than the finished sentences, because a fill is more than
   * one batch: every frame and every pass produces one, and only their sum is
   * the fill's cost. Collapsing to `label: ms` here would leave the background
   * adding up strings.
   */
  readonly matchCostMs: ReadonlyMap<string, number>;
};

export function generateBatch(
  descriptors: readonly FieldDescriptor[],
  source: BatchSource,
): BatchResult {
  const byGroup = new Map<string, FieldValue>();
  const skipped = new Map<string, string>();

  // Measured only where a clock was supplied. `BatchSource` carries its
  // randomness the same way, and for the same reason: this module is testable
  // without a host (NFR-015), so it is handed its capabilities rather than
  // reaching for them — which is also what lets the bound be tested against a
  // fake clock instead of against a machine that has to really be slow.
  const cost: MatchCost | undefined =
    source.now === undefined ? undefined : { now: source.now, ms: new Map() };

  const values = descriptors.map((descriptor) => {
    const group = descriptor.group;
    if (group === undefined) {
      return valueFor(descriptor, source, source.randomFor(descriptor.token), skipped, cost);
    }

    const decided = byGroup.get(group);
    // Generated once for the group and handed to every member; each ticks itself
    // only if it holds the chosen value, so exactly one does. Seeded from the
    // group's token rather than any one member's, so the group keeps its answer
    // across passes for the same reason a single control keeps its value.
    const value = decided ?? valueFor(descriptor, source, source.randomFor(group), skipped, cost);
    if (decided === undefined) byGroup.set(group, value);

    return { ...value, ref: descriptor.ref };
  });

  return {
    values,
    skippedRules: [...skipped].map(([label, reason]) => `${label}: ${reason}`),
    matchCostMs: cost?.ms ?? new Map(),
  };
}

/**
 * One control's value: the first applicable rule, or the built-in generator.
 *
 * The order here is the whole of DD-005's "where rules stop". Mirroring is
 * checked before any rule is consulted, because a confirmation field's value is
 * decided by the field it confirms and no rule can improve on that. A rule that
 * matches but cannot produce something the control could hold falls through
 * rather than failing, so the field is still filled.
 */
function valueFor(
  descriptor: FieldDescriptor,
  source: BatchSource,
  random: Random,
  skipped: Map<string, string>,
  cost: MatchCost | undefined,
): FieldValue {
  const defaults = source.defaults;
  const fallback = (): FieldValue => generateValue(descriptor, source.persona, random, defaults);

  const rules = source.rules ?? [];
  if (rules.length === 0) return fallback();

  const { selection, skipped: unusable } = selectRule(descriptor, rules, cost);
  for (const entry of unusable) {
    if (entry.problem !== undefined) skipped.set(entry.rule.label, entry.problem);
  }

  if (selection === undefined) return fallback();

  if (mirrorsAnotherField(descriptor, defaults)) {
    const mirrored = fallback();
    return {
      ...mirrored,
      provenance: `${mirrored.provenance} (rule "${selection.rule.label}" overridden: confirmation fields must match)`,
    };
  }

  const text = generateRuleText(selection.rule, source.persona, random);
  if (text === undefined) {
    skipped.set(selection.rule.label, 'its generator could not produce a value');
    return fallback();
  }

  // A rule's output goes through the same fitter as a generated one, carrying
  // the same per-kind caps: the rule supplies policy, the page supplies the
  // ceiling, and the page wins (DD-005, BR-004-7).
  return (
    applyToControl(selection, text, descriptor, (value, control) =>
      constrain(value, control, defaults?.maxLengths)) ?? fallback()
  );
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
