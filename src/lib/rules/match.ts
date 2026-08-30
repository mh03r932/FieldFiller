import type { FieldDescriptor } from '../protocol';
import { MATCH_SOURCES, patternSource, type MatchSource, type Rule, type SourceToggles } from '../settings';

/**
 * Deciding which rule, if any, governs a field (FR-031, FR-067, FR-068).
 *
 * Patterns are compiled once per fill and reused across every control, which is
 * ND-15's correction: the reference builds a `RegExp` per element per rule, so a
 * page with 500 controls and 30 rules constructs 15,000 regexes to fill one form
 * (NFR-025). Here `compileRules` runs once and `selectRule` only tests.
 */

export type CompiledRule = {
  readonly rule: Rule;
  /** Undefined when the pattern would not compile — see `problem`. */
  readonly regex: RegExp | undefined;
  /** The sources this rule may match against, after the global intersection. */
  readonly sources: readonly MatchSource[];
  /** Set when the rule cannot be used, for the report (DD-005). */
  readonly problem: string | undefined;
};

export type Selection = {
  readonly rule: Rule;
  /** Which source the pattern actually matched, for provenance (FR-069). */
  readonly source: MatchSource;
  readonly text: string;
};

/**
 * Prepares an ordered rule list for one fill.
 *
 * Order is precedence: the caller concatenates the active profile's rules ahead
 * of the global list, so a profile rule wins over a global one by position
 * rather than by a separate precedence pass (FR-031).
 *
 * A rule that cannot compile is kept in the list rather than dropped, carrying
 * its problem. Dropping it would make it invisible — and DD-005 chose that an
 * unusable rule is named in the report rather than silently ignored, because
 * silence is how the reference behaves and it is why nobody can tell a rule that
 * did not match from a rule that could not run.
 */
export function compileRules(rules: readonly Rule[], toggles: SourceToggles): readonly CompiledRule[] {
  return rules.map((rule) => {
    const sources = effectiveSources(rule, toggles);

    if (!rule.enabled) {
      return { rule, regex: undefined, sources, problem: undefined };
    }

    try {
      // Case-insensitive always: identities are authored in whatever convention
      // the page's developer used, and a rule that works on `firstName` but not
      // `firstname` is a bug report waiting to happen (see `Matcher`).
      return { rule, regex: new RegExp(patternSource(rule.match), 'i'), sources, problem: undefined };
    } catch (error) {
      return {
        rule,
        regex: undefined,
        sources,
        problem: error instanceof Error ? error.message : 'the pattern could not be compiled',
      };
    }
  });
}

/**
 * The sources a rule may match against (FR-067).
 *
 * Always the intersection with the global toggles, never the rule's list alone:
 * FR-028's switches are how a user silences a noisy source — `className` above
 * all — across every rule at once, and a rule able to opt back in would make
 * that switch a suggestion rather than a bound.
 */
export function effectiveSources(rule: Rule, toggles: SourceToggles): readonly MatchSource[] {
  const enabled = MATCH_SOURCES.filter((source) => toggles[source]);
  if (rule.sources === undefined) return enabled;
  return enabled.filter((source) => rule.sources?.includes(source) === true);
}

/**
 * The first rule that matches this field, and the source it matched on.
 *
 * First match wins (FR-031). Sources are tested in `MATCH_SOURCES` order so the
 * reported provenance is deterministic: a rule whose pattern matches both `name`
 * and `id` always reports the same one, rather than whichever the object
 * happened to enumerate first.
 */
export function selectRule(
  descriptor: FieldDescriptor,
  compiled: readonly CompiledRule[],
  cost?: MatchCost,
): { readonly selection: Selection | undefined; readonly skipped: readonly CompiledRule[] } {
  const skipped: CompiledRule[] = [];

  for (const entry of compiled) {
    if (!entry.rule.enabled) continue;
    if (entry.regex === undefined) {
      if (entry.problem !== undefined) skipped.push(entry);
      continue;
    }

    // One clock pair per rule per control, and only when an accumulator was
    // supplied. Per *rule* rather than per control, because the rule is what the
    // user can delete; per control would say a fill was slow without saying
    // which of twenty rules to look at. Per *source* would be seven times the
    // clock calls to attribute something no one can act on differently.
    const at = cost?.now();

    for (const source of entry.sources) {
      const text = descriptor.sources[source];
      if (text === undefined || text === '') continue;

      entry.regex.lastIndex = 0;
      if (entry.regex.test(text)) {
        if (cost !== undefined && at !== undefined) charge(cost, entry.rule.label, at);
        return { selection: { rule: entry.rule, source, text }, skipped };
      }
    }

    if (cost !== undefined && at !== undefined) charge(cost, entry.rule.label, at);
  }

  return { selection: undefined, skipped };
}

/**
 * Where a fill's matching time goes, rule by rule (NFR-032).
 *
 * An accumulator passed in rather than a value returned, for the reason the
 * `skipped` map in `generateBatch` is: this is a fact about the *fill*, and a
 * per-control return would be five hundred allocations to be summed by whoever
 * received them. The clock is injected for the same reason `randomFor` is —
 * a pure module does not reach for a host — and it makes the bound testable
 * against a fake clock rather than against a machine that has to actually be
 * slow.
 *
 * Optional at the call site because the cost of measuring is not always worth
 * paying: `tests/rules.test.ts` asks `selectRule` what it matched, not what it
 * cost, and threading an accumulator through every such call would be noise.
 */
export type MatchCost = {
  readonly now: () => number;
  readonly ms: Map<string, number>;
};

function charge(cost: MatchCost, label: string, at: number): void {
  cost.ms.set(label, (cost.ms.get(label) ?? 0) + (cost.now() - at));
}

/**
 * How long one rule may spend matching across a whole fill before the report
 * names it (NFR-032).
 *
 * A budget over the *fill* rather than over one control, because that is the
 * scale at which the number means something: 500 controls against an ordinary
 * rule is well under a millisecond in total, and the pattern that prompted this
 * requirement costs 287 ms **per control**. Anything between those is a rule
 * worth looking at, and 100 ms is far enough above the first to never fire on
 * it and far enough below the second to always fire on that.
 *
 * It bounds nothing. A running regular expression cannot be interrupted, so
 * this only decides what the report says afterwards — which is the whole of what
 * NFR-032 asks for after the mechanism it used to prescribe was measured and
 * found to bound nothing either.
 */
export const MATCH_RULE_MS = 100;

/** The rules that overran, worst first, as `label: ms` — the report's own shape. */
export function slowRules(ms: ReadonlyMap<string, number>, boundMs = MATCH_RULE_MS): readonly string[] {
  return [...ms]
    .filter(([, spent]) => spent >= boundMs)
    .sort((left, right) => right[1] - left[1])
    .map(([label, spent]) => `${label}: ${Math.round(spent)} ms`);
}
