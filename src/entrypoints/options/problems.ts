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

/**
 * Draws or updates a problem box without announcing what did not change
 * (NFR-019).
 *
 * Two behaviours live here and neither is styling:
 *
 * *Quiet while pending.* A row or editor that has just been added has a problem
 * only in the sense that nothing has been typed into it yet. Announcing that as
 * an alert — `role="alert"` fires on insertion — reads the user's own click
 * back at them as a failure, so while `pending` the lines render as `.hint`
 * with no live-region role at all. The rule editor calls this state
 * `untouched`; the lists reach it whenever the pattern is blank.
 *
 * *Stable, not replaced.* A freshly inserted alert node announces its content
 * on insertion, so a box replaced on every keystroke re-announces the same
 * sentence once per character typed into a long invalid pattern. The box is
 * reused instead, and its lines are rewritten only when a sentence or its
 * severity actually changed — which is what makes an announcement mean
 * something changed.
 *
 * `className` is written, not appended: the rule editor's boxes carry
 * `problems-match`-style suffixes that must survive the rewrite.
 */
export function reconcileProblems(
  existing: HTMLElement | null,
  className: string,
  lines: readonly string[],
  pending: boolean,
): HTMLElement {
  const box = existing ?? document.createElement('div');
  box.className = className;
  if (pending) box.removeAttribute('role');
  else box.setAttribute('role', 'alert');

  // Same sentences at the same severities: nothing to announce and nothing to
  // write, which is the case on every keystroke that changes nothing.
  const current = Array.from(box.children);
  const lineClass = pending ? 'hint' : 'problem';
  if (
    current.length === lines.length &&
    current.every(
      (child, index) => child.className === lineClass && child.textContent === lines[index],
    )
  ) {
    return box;
  }

  box.replaceChildren(
    ...lines.map((text) => {
      const line = document.createElement('p');
      line.className = lineClass;
      line.textContent = text;
      return line;
    }),
  );
  return box;
}
