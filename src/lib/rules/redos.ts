/**
 * NFR-009 — refusing a pattern that can backtrack catastrophically, when it is
 * stored rather than when it runs.
 *
 * Authoring time is the only place this can be controlled. Once a regex engine
 * starts backtracking there is no way to interrupt it: it is not asynchronous,
 * it does not yield, and in the background context it takes the extension's only
 * thread with it. A pattern that takes exponential time on a 30-character input
 * is indistinguishable from a hang.
 *
 * The check is **structural**, not timed. A trial run makes the verdict depend
 * on how fast the machine is, so the same rule would save on a desktop and be
 * rejected on a laptop — and the rejection would be unreproducible in CI.
 *
 * ## What this does and does not promise
 *
 * DD-005 allows a rule's *match* pattern to use the full syntax the browser's
 * `RegExp` accepts, wider than the subset FR-021 can generate from. This
 * analyser is therefore deliberately tolerant: it reports the shapes it
 * positively recognises and stays silent about constructs it does not model,
 * rather than refusing to parse. **That makes it a filter for the known
 * catastrophic shapes, not a proof of safety** — a pattern it passes is not
 * guaranteed linear. The alternative considered and not taken was rejecting
 * every pattern the analyser cannot fully parse, which would refuse lookahead
 * that the browser supports and users legitimately write.
 *
 * The three shapes below are the ones that cause essentially every real ReDoS.
 */

export type PatternProblem = {
  readonly shape: 'nested-quantifier' | 'nullable-repetition' | 'overlapping-alternation';
  readonly detail: string;
};

/** Quantifiers that permit unbounded (or merely large) repetition. */
const UNBOUNDED = /^(?:\*|\+|\{\d+,\}|\{\d+,(\d{3,})\})/;

/**
 * Reports every catastrophic shape recognised in `pattern`.
 *
 * Never throws and never reports on syntax it does not model — see the note
 * above on what that costs.
 */
export function analysePattern(pattern: string): readonly PatternProblem[] {
  const problems: PatternProblem[] = [];

  for (const group of groupsOf(pattern)) {
    const quantifier = quantifierAfter(pattern, group.end);
    if (quantifier === undefined || !UNBOUNDED.test(quantifier)) continue;

    const body = group.body;

    if (hasTopLevelUnboundedQuantifier(body)) {
      problems.push({
        shape: 'nested-quantifier',
        detail: `"(${body})${quantifier}" repeats a group that already repeats, which is the classic (a+)+ shape`,
      });
      continue;
    }

    if (isNullable(body)) {
      problems.push({
        shape: 'nullable-repetition',
        detail: `"(${body})${quantifier}" repeats a group that can match nothing, so the engine can loop without consuming input`,
      });
      continue;
    }

    const overlap = overlappingBranches(body);
    if (overlap !== undefined) {
      problems.push({
        shape: 'overlapping-alternation',
        detail: `"(${body})${quantifier}" repeats alternatives that can both match "${overlap}", so a failure has to try every split`,
      });
    }
  }

  return problems;
}

type Group = { readonly body: string; readonly end: number };

/**
 * Every parenthesised group, innermost first.
 *
 * Escapes and character classes are tracked so that `\(` and `[(]` cannot
 * unbalance the stack — getting that wrong would make the analyser report on
 * groups that are not there, which is worse than missing one.
 */
function groupsOf(pattern: string): readonly Group[] {
  const groups: Group[] = [];
  const open: number[] = [];
  let inClass = false;

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];

    if (character === '\\') {
      index++;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      inClass = true;
      continue;
    }
    if (character === '(') {
      open.push(index);
      continue;
    }
    if (character === ')') {
      const start = open.pop();
      if (start === undefined) continue;
      groups.push({ body: stripGroupFlags(pattern.slice(start + 1, index)), end: index });
    }
  }

  return groups;
}

/** `?:`, `?=`, `?<name>` and friends are about the group, not its content. */
function stripGroupFlags(body: string): string {
  const match = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(body);
  return match === null ? body : body.slice(match[0].length);
}

function quantifierAfter(pattern: string, end: number): string | undefined {
  const rest = pattern.slice(end + 1);
  const match = /^(?:\*|\+|\?|\{\d+(?:,\d*)?\})/.exec(rest);
  return match === null ? undefined : match[0];
}

/**
 * Whether the body itself ends in — or contains at its own top level — a
 * quantifier that can repeat without bound.
 */
function hasTopLevelUnboundedQuantifier(body: string): boolean {
  for (const [index, character] of scanTopLevel(body)) {
    if (character !== '*' && character !== '+' && character !== '{') continue;
    if (UNBOUNDED.test(body.slice(index))) return true;
  }
  return false;
}

/**
 * Whether the body can match the empty string.
 *
 * Approximated: a body is nullable when every top-level branch is empty, or
 * consists only of elements that are themselves optional (`a?`, `b*`). That
 * covers `(a?)*`, `()*` and `(a*|b*)+` without needing a full parser.
 */
function isNullable(body: string): boolean {
  return topLevelBranches(body).some((branch) => branchIsNullable(branch));
}

function branchIsNullable(branch: string): boolean {
  if (branch === '') return true;

  // Walked element by element rather than character by character. Scanning
  // every character reads a quantifier's own body as content — the `0` in
  // `a{0,3}` becomes an unquantified literal, and the branch is wrongly called
  // non-nullable. That is how this was found.
  let index = 0;
  while (index < branch.length) {
    const end = elementEnd(branch, index);
    const quantifier = quantifierAt(branch, end);
    if (quantifier === undefined) return false;
    // Optional means `?`, `*`, or a counted quantifier that may repeat zero
    // times. Anything else must match at least once, so the branch is not
    // nullable and there is nothing to report.
    if (!quantifier.startsWith('*') && !quantifier.startsWith('?') && !/^\{0\s*[,}]/.test(quantifier)) {
      return false;
    }
    index = end + quantifier.length;
  }

  return true;
}

/**
 * One position past the element starting at `index`.
 *
 * A group or a character class is skipped whole — without that, `(ab)?` would be
 * read as a quantifier on `b`.
 */
function elementEnd(source: string, index: number): number {
  const character = source[index];
  if (character === '\\') return index + 2;
  if (character === '[') return closingIndex(source, index, '[', ']') + 1;
  if (character === '(') return closingIndex(source, index, '(', ')') + 1;
  return index + 1;
}

function quantifierAt(source: string, index: number): string | undefined {
  const match = /^(?:\*|\+|\?|\{\d+(?:,\d*)?\})/.exec(source.slice(index));
  return match === null ? undefined : match[0];
}

function closingIndex(source: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let index = from; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === open) depth++;
    else if (character === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

/**
 * Two top-level alternatives that can begin with the same character.
 *
 * This is what makes `(a|ab)*` and `(a|a)*` exponential: when the overall match
 * fails, every way of splitting the input between the alternatives has to be
 * tried. Approximated by first-character sets, which is enough for the shapes
 * that occur in practice and cannot produce a false positive on branches that
 * genuinely start differently.
 */
function overlappingBranches(body: string): string | undefined {
  const branches = topLevelBranches(body);
  if (branches.length < 2) return undefined;

  const sets = branches.map((branch) => firstCharacters(branch));
  for (let left = 0; left < sets.length; left++) {
    for (let right = left + 1; right < sets.length; right++) {
      const a = sets[left];
      const b = sets[right];
      if (a === undefined || b === undefined) continue;
      for (const character of a) {
        if (b.has(character)) return character;
      }
    }
  }
  return undefined;
}

/**
 * The characters a branch might start with — approximated, and deliberately
 * empty when the answer is not obvious.
 *
 * An unknown leading construct yields the empty set, which means "no overlap
 * claimed". Guessing wide here would reject patterns that are fine, and a false
 * rejection is the failure mode a user cannot work around.
 */
function firstCharacters(branch: string): ReadonlySet<string> {
  const first = branch[0];
  if (first === undefined) return new Set();

  if (first === '\\') {
    const code = branch[1];
    return code === undefined ? new Set() : new Set([`\\${code}`]);
  }
  if (first === '[') {
    const close = closingIndex(branch, 0, '[', ']');
    return new Set(branch.slice(1, close).split('').filter((character) => character !== '^'));
  }
  if (first === '(') {
    const close = closingIndex(branch, 0, '(', ')');
    const inner = stripGroupFlags(branch.slice(1, close));
    const sets = topLevelBranches(inner).map((nested) => firstCharacters(nested));
    return new Set(sets.flatMap((set) => [...set]));
  }
  if (first === '.' || first === '^' || first === '$') return new Set();

  return new Set([first]);
}

/** The body split on top-level `|`, ignoring `|` inside groups or classes. */
function topLevelBranches(body: string): readonly string[] {
  const branches: string[] = [];
  let start = 0;

  for (const [index, character] of scanTopLevel(body)) {
    if (character === '|') {
      branches.push(body.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(body.slice(start));
  return branches;
}

/**
 * Yields `[index, character]` for every position at nesting depth zero, skipping
 * escapes and character-class interiors.
 *
 * One scanner shared by everything above, so "top level" cannot come to mean
 * three slightly different things in three functions.
 */
function* scanTopLevel(source: string): Generator<readonly [number, string]> {
  let depth = 0;
  let inClass = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === undefined) continue;

    if (character === '\\') {
      if (depth === 0 && !inClass) yield [index, character];
      index++;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      if (depth === 0) yield [index, character];
      inClass = true;
      continue;
    }
    if (character === '(') {
      if (depth === 0) yield [index, character];
      depth++;
      continue;
    }
    if (character === ')') {
      depth--;
      continue;
    }
    if (depth === 0) yield [index, character];
  }
}
