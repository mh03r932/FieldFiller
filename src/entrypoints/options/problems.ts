import { message } from '@/lib/platform/i18n';
import type { RuleProblem } from '@/lib/rules/validate';

/**
 * One validation failure as a sentence (NFR-018).
 *
 * `problem.code` goes straight into `message`, whose parameter type is the union
 * of keys WXT generates from the catalog — so a code without a message does not
 * compile, and the pairing needs no test to hold. What this replaced was
 * `message('ruleInvalid', [problem.message])`, where `problem.message` was an
 * English literal compiled into `lib/`: the frame was translatable and the
 * sentence inside it never could be.
 *
 * Shared rather than written out beside each surface, because there are three
 * and they are not variations of each other: the rule editor frames it beside
 * the field that fixes it, the field-exclusion list states it on its own, and
 * the import preview drops it into a line about an entry that is not arriving.
 * Only the frame differs; resolving the fault is the same act every time, and a
 * third copy of these three lines is a third place to forget `params`.
 */
export function problemText(problem: RuleProblem): string {
  return problem.params === undefined ? message(problem.code) : message(problem.code, problem.params);
}
