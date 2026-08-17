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

/**
 * The list operations, re-exported from where they now live.
 *
 * They moved to `lib/lists.ts` when profiles needed the same four (UC-014..016)
 * and a fifth, `moveAt`, that exclusions have no use for — order carries nothing
 * here (BR-020-2). Re-exported rather than repointed at every call site, because
 * a field exclusion's `removeAt` is what this module is *about*, and a screen
 * importing it from `lib/lists` would read as reaching past the abstraction.
 */
export { appendAt, removeAt, replaceAt } from './lists';
