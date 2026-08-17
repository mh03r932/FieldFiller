import type { Matcher } from './settings';

/**
 * The two exclusion lists as values, apart from the page that edits them
 * (UC-020, UC-021).
 *
 * The same split the rule editor makes and for the same reason: what a list
 * *becomes* is a pure function, so the interesting behaviour — where a new entry
 * lands, what a removal does to the entries after it — is testable without a DOM
 * (NFR-015). The options page renders and listens.
 *
 * Order carries no precedence here, unlike a rule list (BR-009-2). An exclusion
 * either matches or does not, and every entry is consulted, so a new one is
 * appended for predictability rather than because the position means anything.
 */

/** A blank field-exclusion matcher, in the mode a user most often wants. */
export function newExclusion(): Matcher {
  // `contains` rather than `regex`: the commonest exclusion is a literal — a
  // CAPTCHA field, a coupon code — and starting in the mode that needs no
  // escaping is what keeps the simple case simple. Starting in `regex` would
  // make `credit.card` quietly match `credit-card` too.
  return { mode: 'contains', pattern: '' };
}

export function appendAt<T>(items: readonly T[], item: T): readonly T[] {
  return [...items, item];
}

export function replaceAt<T>(items: readonly T[], at: number, item: T): readonly T[] {
  return items.map((existing, index) => (index === at ? item : existing));
}

/**
 * Removes one entry by position.
 *
 * By index rather than by value, because neither list holds identifiers and both
 * can hold duplicates: two identical patterns are a redundant configuration
 * rather than an illegal one, and removing "the pattern equal to this" would
 * take the first of them however far down the list the user clicked.
 */
export function removeAt<T>(items: readonly T[], at: number): readonly T[] {
  return items.filter((_, index) => index !== at);
}
