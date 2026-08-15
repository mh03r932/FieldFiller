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
): { readonly selection: Selection | undefined; readonly skipped: readonly CompiledRule[] } {
  const skipped: CompiledRule[] = [];

  for (const entry of compiled) {
    if (!entry.rule.enabled) continue;
    if (entry.regex === undefined) {
      if (entry.problem !== undefined) skipped.push(entry);
      continue;
    }

    for (const source of entry.sources) {
      const text = descriptor.sources[source];
      if (text === undefined || text === '') continue;

      entry.regex.lastIndex = 0;
      if (entry.regex.test(text)) {
        return { selection: { rule: entry.rule, source, text }, skipped };
      }
    }
  }

  return { selection: undefined, skipped };
}
