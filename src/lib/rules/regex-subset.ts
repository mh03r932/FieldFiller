import type { Random } from '../persona/persona';

/**
 * FR-021 — a value generated from a regular expression.
 *
 * The subset is bounded and documented rather than "whatever the implementation
 * happens to handle", and anything outside it is rejected **at save time**
 * (FR-070) with the construct named. That ordering is the requirement: a pattern
 * that cannot be generated from must fail when the user writes it, not when a
 * page is being filled.
 *
 * What is supported:
 *   literals · `.` · escapes `\d \D \w \W \s \S` and `\n \t \r \\` etc.
 *   character classes `[a-z0-9_-]`, negated `[^…]`
 *   groups `(…)` and `(?:…)` · alternation `|`
 *   quantifiers `? * + {n} {n,} {n,m}`, with or without a trailing lazy `?`
 *   anchors `^ $`, which contribute nothing to the output
 *
 * What is rejected, by name: lookahead and lookbehind, backreferences, named
 * groups, and unicode property escapes. Each is a construct about *matching*
 * rather than about the shape of a string, and none has a meaningful reading as
 * "generate something like this".
 *
 * Values are drawn from a deliberately narrow alphabet — see `SAMPLE_ALPHABET`.
 * Every value produced still matches the pattern; the narrowing only decides
 * *which* matching value, and it is what keeps `.` from filling a form with
 * control characters.
 */

type RegexNode =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'set'; readonly chars: string }
  | { readonly kind: 'seq'; readonly nodes: readonly RegexNode[] }
  | { readonly kind: 'alt'; readonly options: readonly RegexNode[] }
  | { readonly kind: 'repeat'; readonly node: RegexNode; readonly min: number; readonly max: number }
  | { readonly kind: 'empty' };

type ParseResult =
  | { readonly ok: true; readonly node: RegexNode }
  | { readonly ok: false; readonly problem: string };

/**
 * How far an unbounded quantifier is allowed to expand, beyond its minimum.
 *
 * Measured rather than picked: across the reference and cascade fixtures the
 * longest declared `maxlength` is 12 and the largest lower bound inside a
 * declared `pattern` is `{8,}`. Honouring the minimum exactly and adding at most
 * eight therefore cannot truncate anything those pages ask for, while keeping
 * the work per rule finite. `TOTAL_LIMIT` is the second bound, because nesting
 * multiplies: `(ab{0,8}){0,8}` is still small, but four levels is not.
 */
const MAX_EXTRA = 8;
const TOTAL_LIMIT = 256;

/**
 * The alphabet `.`, `\W`, `\S` and negated classes draw from.
 *
 * Alphanumerics plus a few separators that appear in real field formats. A
 * generated value is a *sample* of the pattern's language, and choosing a
 * readable corner of it is the difference between a usable dummy value and a
 * line of noise the tester then has to retype.
 */
const SAMPLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ';

const DIGITS = '0123456789';
const WORD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
/** Space alone. A generated tab or form feed is legal and never what was meant. */
const SPACE = ' ';

const CONTROL_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  v: '\v',
  0: '\0',
};

/** Parses one pattern into the subset's AST, or explains why it cannot. */
export function parseRegex(pattern: string): ParseResult {
  const parser = new Parser(pattern);
  try {
    const node = parser.parseAlternation();
    if (!parser.done()) {
      // The only way to stop early is an unbalanced `)`, because every other
      // atom either consumes or throws.
      return { ok: false, problem: `unbalanced ")" at position ${String(parser.position)}` };
    }
    return { ok: true, node };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : 'could not be parsed' };
  }
}

/** Draws one string matching `node`, using `random` for every choice. */
export function generateFromRegex(node: RegexNode, random: Random): string {
  const budget = { remaining: TOTAL_LIMIT };
  return emit(node, random, budget);
}

function emit(node: RegexNode, random: Random, budget: { remaining: number }): string {
  if (budget.remaining <= 0) return '';

  switch (node.kind) {
    case 'empty':
      return '';

    case 'literal': {
      const text = node.text.slice(0, budget.remaining);
      budget.remaining -= text.length;
      return text;
    }

    case 'set': {
      budget.remaining -= 1;
      return node.chars[Math.floor(random() * node.chars.length)] ?? '';
    }

    case 'seq': {
      let out = '';
      for (const child of node.nodes) out += emit(child, random, budget);
      return out;
    }

    case 'alt': {
      const chosen = node.options[Math.floor(random() * node.options.length)];
      return chosen === undefined ? '' : emit(chosen, random, budget);
    }

    case 'repeat': {
      const span = node.max - node.min;
      const count = node.min + (span > 0 ? Math.floor(random() * (span + 1)) : 0);
      let out = '';
      for (let index = 0; index < count; index++) {
        if (budget.remaining <= 0) break;
        out += emit(node.node, random, budget);
      }
      return out;
    }
  }
}

class Parser {
  position = 0;

  constructor(private readonly source: string) {}

  done(): boolean {
    return this.position >= this.source.length;
  }

  private peek(): string | undefined {
    return this.source[this.position];
  }

  parseAlternation(): RegexNode {
    const options: RegexNode[] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.position++;
      options.push(this.parseSequence());
    }
    return options.length === 1 ? (options[0] as RegexNode) : { kind: 'alt', options };
  }

  private parseSequence(): RegexNode {
    const nodes: RegexNode[] = [];
    while (!this.done() && this.peek() !== '|' && this.peek() !== ')') {
      nodes.push(this.parseQuantified());
    }
    if (nodes.length === 0) return { kind: 'empty' };
    return nodes.length === 1 ? (nodes[0] as RegexNode) : { kind: 'seq', nodes };
  }

  private parseQuantified(): RegexNode {
    const atom = this.parseAtom();
    const quantifier = this.parseQuantifier();
    if (quantifier === undefined) return atom;

    // A trailing `?` makes the quantifier lazy. Laziness is about which match a
    // matcher prefers, not about which strings are in the language, so it is
    // accepted and has no effect on generation.
    if (this.peek() === '?') this.position++;

    return { kind: 'repeat', node: atom, min: quantifier.min, max: quantifier.max };
  }

  private parseQuantifier(): { min: number; max: number } | undefined {
    const next = this.peek();
    if (next === '*') {
      this.position++;
      return { min: 0, max: MAX_EXTRA };
    }
    if (next === '+') {
      this.position++;
      return { min: 1, max: 1 + MAX_EXTRA };
    }
    if (next === '?') {
      this.position++;
      return { min: 0, max: 1 };
    }
    if (next !== '{') return undefined;

    const close = this.source.indexOf('}', this.position);
    if (close === -1) return undefined;

    const body = this.source.slice(this.position + 1, close);
    const match = /^(\d+)(,(\d*)?)?$/.exec(body);
    // `{` that is not a counted quantifier is a literal brace, which is what the
    // browser does too. Leaving it to `parseAtom` keeps one reading of `{`.
    if (match === null) return undefined;

    this.position = close + 1;
    const min = Number(match[1]);
    if (match[2] === undefined) return { min, max: min };
    const upper = match[3];
    return upper === undefined || upper === ''
      ? { min, max: min + MAX_EXTRA }
      : { min, max: Math.max(min, Number(upper)) };
  }

  private parseAtom(): RegexNode {
    const next = this.peek();

    if (next === '(') return this.parseGroup();
    if (next === '[') return this.parseClass();
    if (next === '\\') return this.parseEscape();

    this.position++;
    if (next === '.') return { kind: 'set', chars: SAMPLE_ALPHABET };
    // Anchors contribute nothing to the output; a value generated for `^ab$` is
    // `ab`, which is what the user meant by writing them.
    if (next === '^' || next === '$') return { kind: 'empty' };
    return { kind: 'literal', text: next ?? '' };
  }

  private parseGroup(): RegexNode {
    this.position++; // '('

    if (this.source.startsWith('(?', this.position - 1)) {
      const marker = this.source.slice(this.position, this.position + 2);
      if (marker.startsWith('?=') || marker.startsWith('?!')) {
        throw new Error('lookahead is not supported: a value cannot be generated from a condition on what follows it');
      }
      if (marker.startsWith('?<')) {
        // `(?<name>` is a named group and `(?<=` / `(?<!` are lookbehind. Both
        // are refused, but for different reasons, so they are told apart.
        const named = /^\?<[A-Za-z_$]/.test(this.source.slice(this.position));
        throw new Error(
          named
            ? 'named groups are not supported: a generated value has nothing to name'
            : 'lookbehind is not supported: a value cannot be generated from a condition on what precedes it',
        );
      }
      if (marker.startsWith('?:')) {
        this.position += 2;
      } else {
        throw new Error(`the group flag "(${marker}" is not supported`);
      }
    }

    const inner = this.parseAlternation();
    if (this.peek() !== ')') throw new Error('unbalanced "(": the group is never closed');
    this.position++;
    return inner;
  }

  private parseClass(): RegexNode {
    this.position++; // '['
    const negated = this.peek() === '^';
    if (negated) this.position++;

    let chars = '';
    let closed = false;

    while (!this.done()) {
      const next = this.peek() as string;
      if (next === ']') {
        this.position++;
        closed = true;
        break;
      }

      if (next === '\\') {
        chars += this.classEscape();
        continue;
      }

      this.position++;
      // A `-` between two literals is a range; anywhere else it is itself.
      if (this.peek() === '-' && this.source[this.position + 1] !== ']' && this.position + 1 < this.source.length) {
        const upper = this.source[this.position + 1] as string;
        this.position += 2;
        chars += expandRange(next, upper);
        continue;
      }
      chars += next;
    }

    if (!closed) throw new Error('unbalanced "[": the character class is never closed');
    if (chars === '') throw new Error('an empty character class matches nothing, so nothing can be generated');

    const set = negated ? complement(chars) : chars;
    if (set === '') {
      throw new Error('the negated character class excludes every character this generator can produce');
    }
    return { kind: 'set', chars: dedupe(set) };
  }

  /** One escape inside a class, where `\d` and friends contribute their whole set. */
  private classEscape(): string {
    this.position++; // '\'
    const code = this.peek();
    if (code === undefined) throw new Error('a trailing "\\" escapes nothing');
    this.position++;

    const shorthand = shorthandSet(code);
    if (shorthand !== undefined) return shorthand;
    return CONTROL_ESCAPES[code] ?? code;
  }

  private parseEscape(): RegexNode {
    this.position++; // '\'
    const code = this.peek();
    if (code === undefined) throw new Error('a trailing "\\" escapes nothing');

    if (/[1-9]/.test(code)) {
      throw new Error('backreferences are not supported: there is no earlier match to refer to when generating');
    }
    if (code === 'p' || code === 'P') {
      throw new Error('unicode property escapes are not supported');
    }
    if (code === 'b' || code === 'B') {
      // A word boundary is a position, not a character.
      this.position++;
      return { kind: 'empty' };
    }

    this.position++;
    const shorthand = shorthandSet(code);
    if (shorthand !== undefined) return { kind: 'set', chars: shorthand };

    const control = CONTROL_ESCAPES[code];
    if (control !== undefined) return { kind: 'literal', text: control };
    return { kind: 'literal', text: code };
  }
}

function shorthandSet(code: string): string | undefined {
  switch (code) {
    case 'd':
      return DIGITS;
    case 'D':
      return complement(DIGITS);
    case 'w':
      return WORD;
    case 'W':
      return complement(WORD);
    case 's':
      return SPACE;
    case 'S':
      return complement(SPACE);
    default:
      return undefined;
  }
}

/** Everything in the sample alphabet that `excluded` does not cover. */
function complement(excluded: string): string {
  let out = '';
  for (const character of SAMPLE_ALPHABET) {
    if (!excluded.includes(character)) out += character;
  }
  return out;
}

function expandRange(from: string, to: string): string {
  const start = from.charCodeAt(0);
  const end = to.charCodeAt(0);
  if (end < start) throw new Error(`the range "${from}-${to}" runs backwards`);

  let out = '';
  // Bounded so that `[\x00-\uffff]` cannot build a 65k-character string per
  // rule; the cap is far above any range a field format uses.
  for (let code = start; code <= Math.min(end, start + 255); code++) {
    out += String.fromCharCode(code);
  }
  return out;
}

function dedupe(chars: string): string {
  return [...new Set(chars)].join('');
}
