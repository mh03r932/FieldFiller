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

export type RuleProblem = {
  /** Which part of the rule the user has to fix. */
  readonly field: 'match' | 'generator';
  readonly message: string;
};

export function validateRule(rule: Rule): readonly RuleProblem[] {
  return [...validateMatcher(rule.match), ...validateGenerator(rule.generator)];
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
    return [{ field: 'match', message: 'the pattern is empty' }];
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
        message: `not a valid regular expression: ${error instanceof Error ? error.message : 'unparseable'}`,
      });
      return problems;
    }
  }

  for (const problem of analysePattern(matcher.pattern)) {
    problems.push({
      field: 'match',
      message: `this pattern can backtrack catastrophically and would hang the extension — ${problem.detail}`,
    });
  }

  return problems;
}

function validateGenerator(generator: Generator): readonly RuleProblem[] {
  switch (generator.type) {
    case 'alphanumeric': {
      const parsed = parseTemplate(generator.template);
      return parsed.ok ? [] : [{ field: 'generator', message: parsed.problem }];
    }

    case 'regex': {
      const problems: RuleProblem[] = [];
      // Both checks, and both messages: the subset decides whether a value can
      // be produced at all, the analyser whether producing it is safe. A pattern
      // can fail either independently.
      const parsed = parseRegex(generator.pattern);
      if (!parsed.ok) {
        problems.push({ field: 'generator', message: `cannot generate from this pattern: ${parsed.problem}` });
      }
      for (const problem of analysePattern(generator.pattern)) {
        problems.push({
          field: 'generator',
          message: `this pattern can backtrack catastrophically — ${problem.detail}`,
        });
      }
      return problems;
    }

    case 'list':
      return generator.items.length === 0
        ? [{ field: 'generator', message: 'a randomized list needs at least one item' }]
        : [];

    case 'number':
      return generator.min > generator.max
        ? [{ field: 'generator', message: 'the minimum is greater than the maximum' }]
        : [];

    case 'text':
      return generator.minWords > generator.maxWords
        ? [{ field: 'generator', message: 'the shortest length is greater than the longest' }]
        : [];

    case 'date': {
      const problems: RuleProblem[] = [];
      if (!hasDateToken(generator.format)) {
        problems.push({
          field: 'generator',
          message: 'the format contains no date token, so every field would receive the format itself',
        });
      }
      if (!isIsoDate(generator.from) || !isIsoDate(generator.to)) {
        problems.push({ field: 'generator', message: 'the range bounds must be real dates, as YYYY-MM-DD' });
      } else if (generator.from > generator.to) {
        problems.push({ field: 'generator', message: 'the range starts after it ends' });
      }
      return problems;
    }

    default:
      // The remaining types carry no user-authored syntax: there is nothing
      // about `{ type: 'email' }` that can be invalid.
      return [];
  }
}
