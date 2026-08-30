import type { Random } from '../persona/persona';

/**
 * FR-020 — the alphanumeric template grammar.
 *
 * Ours, not the reference's. Its templates are single letters interpreted
 * positionally (`L` for a letter, `C` for a consonant, and so on), which means
 * the template `LLL-DDD` cannot contain a literal `L`, there is no way to say
 * "eight digits" without typing eight characters, and an unknown letter is
 * silently emitted as itself — so a typo produces a plausible-looking wrong
 * value rather than an error.
 *
 * Here a placeholder is braced and named:
 *
 *     INV-{digit:4}-{upper:2}      → INV-8143-QT
 *     {upper}{lower:5}             → Kmtrea
 *     {consonant}{vowel}{digit:3}  → ba417
 *
 * Everything outside braces is a literal, so a template is readable as the thing
 * it produces. `{{` and `}}` are literal braces. An unknown placeholder name is
 * an error at save time (FR-070), naming what was written — the whole reason for
 * a closed vocabulary is that a misspelling should be impossible to ship.
 */

const ALPHABETS: Record<string, string> = {
  letter: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  // Without vowels, so that consonant/vowel alternation produces pronounceable
  // strings — which is the only reason to have the two separately at all.
  consonant: 'bcdfghjklmnpqrstvwxyz',
  vowel: 'aeiou',
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  symbol: '!@#$%&*?-_',
};

const TEMPLATE_TOKENS: readonly string[] = Object.keys(ALPHABETS);

/** No single placeholder may expand beyond this, so one template cannot run away. */
const MAX_COUNT = 64;

type Part =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'draw'; readonly alphabet: string; readonly count: number };

type TemplateResult =
  | { readonly ok: true; readonly parts: readonly Part[] }
  | { readonly ok: false; readonly problem: string };

export function parseTemplate(template: string): TemplateResult {
  const parts: Part[] = [];
  let literal = '';

  for (let index = 0; index < template.length; index++) {
    const character = template[index];

    if (character === '{' && template[index + 1] === '{') {
      literal += '{';
      index++;
      continue;
    }
    if (character === '}' && template[index + 1] === '}') {
      literal += '}';
      index++;
      continue;
    }

    if (character !== '{') {
      literal += character;
      continue;
    }

    const close = template.indexOf('}', index);
    if (close === -1) {
      return { ok: false, problem: `"{" at position ${String(index)} is never closed` };
    }

    const placeholder = parsePlaceholder(template.slice(index + 1, close));
    if (!placeholder.ok) return placeholder;

    if (literal !== '') {
      parts.push({ kind: 'literal', text: literal });
      literal = '';
    }
    parts.push(placeholder.part);
    index = close;
  }

  if (literal !== '') parts.push({ kind: 'literal', text: literal });
  if (parts.length === 0) return { ok: false, problem: 'the template is empty' };

  return { ok: true, parts };
}

function parsePlaceholder(body: string): { ok: true; part: Part } | { ok: false; problem: string } {
  const [name, count] = body.includes(':') ? splitOnce(body, ':') : [body, '1'];

  const alphabet = ALPHABETS[name];
  if (alphabet === undefined) {
    return {
      ok: false,
      problem: `"{${body}}" is not a placeholder. Available: ${TEMPLATE_TOKENS.join(', ')}`,
    };
  }

  if (!/^\d+$/.test(count)) {
    return { ok: false, problem: `"{${body}}" has a count that is not a whole number` };
  }

  const repeats = Number(count);
  if (repeats < 1 || repeats > MAX_COUNT) {
    return { ok: false, problem: `"{${body}}" must repeat between 1 and ${String(MAX_COUNT)} times` };
  }

  return { ok: true, part: { kind: 'draw', alphabet, count: repeats } };
}

function splitOnce(body: string, separator: string): [string, string] {
  const at = body.indexOf(separator);
  return [body.slice(0, at), body.slice(at + 1)];
}

export function generateFromTemplate(parts: readonly Part[], random: Random): string {
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
    for (let index = 0; index < part.count; index++) {
      out += part.alphabet[Math.floor(random() * part.alphabet.length)] ?? '';
    }
  }
  return out;
}
