import type { Generator, Rule } from '../settings';
import { createPersona, seededRandom, type Locale } from '../persona/persona';
import { generateRuleText } from './generate';
import { validateRule, type RuleProblem } from './validate';

/**
 * The rule list as a value, apart from the page that edits it (UC-009..UC-013).
 *
 * Every operation here is a pure function from one rule list to another. That is
 * what lets the whole of the editor's behaviour — where a new rule lands, what
 * survives a change of generator type, what a move does at the end of the list —
 * be tested without a DOM, and it keeps the options page to rendering and
 * events (NFR-015, the same argument the engine makes).
 */

/** A new rule, in the state UC-009 step 2 describes. */
export function newRule(id: string): Rule {
  return {
    id,
    label: '',
    enabled: true,
    // Matches nothing yet: an empty pattern is invalid, so the rule is not
    // written until the user has said what it is for (BR-009-1). Creating it
    // pre-matching *something* would mean a rule that starts by doing whatever
    // the default pattern happened to hit.
    match: { mode: 'contains', pattern: '' },
    generator: { type: 'text', minWords: 3, maxWords: 8 },
    // Coherence on by default (DD-005): a rule written without thinking about
    // the flag keeps the record consistent.
    fromPersona: true,
  };
}

/** Appends, never inserts. Order is precedence, so last changes nothing (BR-009-2). */
export function addRule(rules: readonly Rule[], id: string): readonly Rule[] {
  return [...rules, newRule(id)];
}

export function replaceRule(rules: readonly Rule[], updated: Rule): readonly Rule[] {
  return rules.map((rule) => (rule.id === updated.id ? updated : rule));
}

export function removeRule(rules: readonly Rule[], id: string): readonly Rule[] {
  return rules.filter((rule) => rule.id !== id);
}

/**
 * Puts a rule back where it was (UC-011 A1).
 *
 * Restoring to the end would be a different configuration from the one deleted —
 * the user asked to undo, not to re-add.
 */
export function restoreRule(rules: readonly Rule[], rule: Rule, at: number): readonly Rule[] {
  const restored = [...rules];
  restored.splice(Math.max(0, Math.min(at, rules.length)), 0, rule);
  return restored;
}

/**
 * Moves a rule one place (UC-012).
 *
 * Returns the list unchanged at either end rather than wrapping: a rule that
 * silently jumps from first to last would rewrite the precedence of every rule
 * between them.
 */
export function moveRule(rules: readonly Rule[], id: string, direction: -1 | 1): readonly Rule[] {
  const from = rules.findIndex((rule) => rule.id === id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= rules.length) return rules;

  const moved = [...rules];
  const [rule] = moved.splice(from, 1);
  moved.splice(to, 0, rule as Rule);
  return moved;
}

/**
 * The defaults for each generator type.
 *
 * Chosen so a freshly switched type is *valid immediately* — an empty template
 * or a backwards range would show the user a validation error they did not
 * cause, on a rule they have not finished writing.
 */
export function defaultGenerator(type: Generator['type']): Generator {
  switch (type) {
    case 'name':
      return { type, part: 'full' };
    case 'number':
      return { type, min: 1, max: 100, decimals: 0 };
    case 'date':
      return { type, format: 'YYYY-MM-DD', from: '1990-01-01', to: '2035-12-31' };
    case 'text':
      return { type, minWords: 3, maxWords: 8 };
    case 'alphanumeric':
      return { type, template: 'INV-{digit:4}' };
    case 'regex':
      return { type, pattern: '[A-Z]{3}-\\d{4}' };
    case 'list':
      return { type, items: ['first', 'second'] };
    case 'constant':
      return { type, value: '' };
    default:
      // The persona-backed types carry no options of their own, so the
      // discriminant is the whole generator.
      return { type };
  }
}

/**
 * Changes a rule's generator type, keeping what still means something (UC-009 A4).
 *
 * The name, the matcher, the source scoping and the persona flag survive; the
 * previous type's options do not, because they mean nothing to the new one. A
 * date format is not a regex, and carrying it across is how ND-9's overloaded
 * `template` field became unreadable in the first place.
 */
export function changeGeneratorType(rule: Rule, type: Generator['type']): Rule {
  return rule.generator.type === type ? rule : { ...rule, generator: defaultGenerator(type) };
}

export type Sample =
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false; readonly problems: readonly RuleProblem[] }
  /** Valid, but the generator could not produce anything (UC-013 A2). */
  | { readonly ok: false; readonly problems: readonly []; readonly unusable: true };

/** How many samples a preview shows. Enough to see variability (BR-013-1). */
const SAMPLE_COUNT = 4;

/**
 * What a rule would produce, for the preview (UC-013).
 *
 * Drawn from the same generators a fill runs (BR-009-4), and from a *fresh
 * persona per sample* (BR-013-2): the coherence flag makes a rule agree with the
 * rest of one form, and a preview is not a form, so showing one person's email
 * four times would misrepresent what the flag does.
 *
 * `seed` is a parameter so a test can pin it. The page passes a changing one, so
 * successive previews of an unchanged rule still show fresh values.
 */
export function sampleRule(rule: Rule, locale: Locale, seed: number): Sample {
  const problems = validateRule(rule);
  // An invalid rule shows its problem and *no* samples — stale output that no
  // longer belongs to what is on screen is worse than none (UC-013 A1).
  if (problems.length > 0) return { ok: false, problems };

  const values: string[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const random = seededRandom(seed + index);
    const produced = generateRuleText(rule, createPersona(random, locale), random);
    if (produced === undefined) return { ok: false, problems: [], unusable: true };
    values.push(produced.text);
  }
  return { ok: true, values };
}
