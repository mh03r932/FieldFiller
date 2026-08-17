import type { Generator, Matcher, Rule } from '../settings';
import { analysePattern } from './redos';
import { parseRegex } from './regex-subset';
import { parseTemplate } from './template';
import { hasDateToken, isIsoDate } from './dates';

/**
 * FR-070 — a rule is rejected when it is saved, not when a page is filled.
 *
 * The reference constructs its regexes inside the fill loop, per element, per
 * rule (ND-15), so an invalid pattern surfaces as a thrown error in the middle
 * of filling — on whichever page the user happened to be on, with no indication
 * of which rule caused it. Validating at authoring time turns that into a
 * message beside the field the user is editing.
 *
 * Every function here is pure and host-free, so the same check runs in the
 * options page (Phase 4), in the importer (UC-026, UC-027), and in the tests.
 */

/**
 * Every fault this module can report, named as a catalog key (NFR-018).
 *
 * A code rather than a sentence, because this module is host-free by design —
 * it runs in the options page, in the importer and in the tests, and only the
 * first of those has a catalog to read. Returning prose meant the surface
 * resolved half a sentence from the catalog and concatenated the other half from
 * a string literal compiled into `lib/`, so no translation of "Not saved: the
 * range starts after it ends" could ever be complete.
 *
 * The names are the catalog keys themselves rather than an enum mapped to them
 * later. That is what makes the pairing checkable: `rules.ts` passes a code
 * straight to `message()`, whose parameter is the union of keys WXT generates
 * from `messages.json`, so a code with no message — or a message deleted out
 * from under a code — is a compile error rather than a blank line beside a field.
 */
export type RuleProblemCode =
  | 'ruleProblemPatternEmpty'
  | 'ruleProblemPatternInvalid'
  | 'ruleProblemPatternBacktracks'
  | 'ruleProblemNoSources'
  | 'ruleProblemTemplateInvalid'
  | 'ruleProblemRegexUngeneratable'
  | 'ruleProblemGeneratorBacktracks'
  | 'ruleProblemListEmpty'
  | 'ruleProblemNumberRange'
  | 'ruleProblemTextRange'
  | 'ruleProblemDateNoToken'
  | 'ruleProblemDateBounds'
  | 'ruleProblemDateRange';

export type RuleProblem = {
  /** Which part of the rule the user has to fix. */
  readonly field: 'match' | 'sources' | 'generator';
  readonly code: RuleProblemCode;
  /**
   * Substitutions for the message, in order.
   *
   * Where present these carry diagnostic detail from a parser below — the
   * position a brace was left open, the group that backtracks, the engine's own
   * complaint about a pattern it would not compile. Those strings are still
   * English: they name constructs rather than address the user, and the
   * sentence that *does* address the user is the one in the catalog around them.
   */
  readonly params?: readonly string[];
};

export function validateRule(rule: Rule): readonly RuleProblem[] {
  return [
    ...validateMatcher(rule.match),
    ...validateSources(rule.sources),
    ...validateGenerator(rule.generator),
  ];
}

/**
 * A rule that names its own sources has to name at least one (FR-067).
 *
 * An empty list is well-shaped, survives the parser deliberately, and matches
 * nothing at all: `effectiveSources` intersects it with the global toggles and
 * `selectRule` then iterates an empty list, so the rule can never fire. Nothing
 * else says so — the preview draws from the generator, which is perfectly
 * healthy — which made unticking the last of the six a way to save a rule that
 * looks finished and is dead. Reachable in one click from the editor, so it is
 * checked here rather than left to the fill.
 *
 * Only the empty case. A rule whose sources are all switched off *globally* is
 * also inert, but that is a property of the pair rather than of the rule, it
 * changes without the rule being touched, and the fill report already names a
 * rule that could not run.
 */
function validateSources(sources: Rule['sources']): readonly RuleProblem[] {
  if (sources === undefined || sources.length > 0) return [];
  return [{ field: 'sources', code: 'ruleProblemNoSources' }];
}

/**
 * A pattern that will compile, and that no known catastrophic shape matches.
 *
 * Used for rule matching and for field exclusions alike, so the two cannot drift
 * into accepting different things.
 */
export function validateMatcher(matcher: Matcher): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];

  if (matcher.pattern === '') {
    return [{ field: 'match', code: 'ruleProblemPatternEmpty' }];
  }

  if (matcher.mode !== 'regex') {
    // `contains` and `exact` are escaped before they are compiled, so there is
    // no syntax to get wrong and no backtracking to analyse. That is most of
    // the reason the modes exist.
    return problems;
  }

  try {
    new RegExp(matcher.pattern, 'iu');
  } catch {
    try {
      // Without `u`, because a pattern written for the non-unicode dialect —
      // a bare `\p`, an unescaped `{` — is legal there and rejecting it would
      // be rejecting valid input over a flag the user never chose.
      new RegExp(matcher.pattern, 'i');
    } catch (error) {
      problems.push({
        field: 'match',
        code: 'ruleProblemPatternInvalid',
        params: [error instanceof Error ? error.message : 'unparseable'],
      });
      return problems;
    }
  }

  for (const problem of analysePattern(matcher.pattern)) {
    problems.push({
      field: 'match',
      code: 'ruleProblemPatternBacktracks',
      params: [problem.detail],
    });
  }

  return problems;
}

function validateGenerator(generator: Generator): readonly RuleProblem[] {
  switch (generator.type) {
    case 'alphanumeric': {
      const parsed = parseTemplate(generator.template);
      return parsed.ok
        ? []
        : [{ field: 'generator', code: 'ruleProblemTemplateInvalid', params: [parsed.problem] }];
    }

    case 'regex': {
      const problems: RuleProblem[] = [];
      // Both checks, and both messages: the subset decides whether a value can
      // be produced at all, the analyser whether producing it is safe. A pattern
      // can fail either independently.
      const parsed = parseRegex(generator.pattern);
      if (!parsed.ok) {
        problems.push({
          field: 'generator',
          code: 'ruleProblemRegexUngeneratable',
          params: [parsed.problem],
        });
      }
      for (const problem of analysePattern(generator.pattern)) {
        problems.push({
          field: 'generator',
          code: 'ruleProblemGeneratorBacktracks',
          params: [problem.detail],
        });
      }
      return problems;
    }

    case 'list':
      return generator.items.length === 0
        ? [{ field: 'generator', code: 'ruleProblemListEmpty' }]
        : [];

    case 'number':
      return generator.min > generator.max
        ? [{ field: 'generator', code: 'ruleProblemNumberRange' }]
        : [];

    case 'text':
      return generator.minWords > generator.maxWords
        ? [{ field: 'generator', code: 'ruleProblemTextRange' }]
        : [];

    case 'date': {
      const problems: RuleProblem[] = [];
      if (!hasDateToken(generator.format)) {
        problems.push({ field: 'generator', code: 'ruleProblemDateNoToken' });
      }
      if (!isIsoDate(generator.from) || !isIsoDate(generator.to)) {
        problems.push({ field: 'generator', code: 'ruleProblemDateBounds' });
      } else if (generator.from > generator.to) {
        problems.push({ field: 'generator', code: 'ruleProblemDateRange' });
      }
      return problems;
    }

    default:
      // The remaining types carry no user-authored syntax: there is nothing
      // about `{ type: 'email' }` that can be invalid.
      return [];
  }
}
