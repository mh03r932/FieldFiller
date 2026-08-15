import type { FillScope, ScopeRefusal, ScopeRule } from '../protocol';

/**
 * Resolving what "the current form" means (DD-008, UC-002).
 *
 * Most application forms are not `<form>` elements — a React checkout is a
 * `<div>` — so a scope named "the current form" has to be resolved from what the
 * page does express. This is a **ladder**, not a heuristic: the first rule that
 * matches wins and the result says which one did, because a scope the user
 * cannot predict is the same defect as a rule they cannot predict (ND-2).
 *
 * Host-free and DOM-only, so the whole of DD-008 is testable without an
 * extension (NFR-015).
 */

export type Resolution =
  /** A subtree to walk: the page, or the form the ladder resolved. */
  | { readonly resolved: true; readonly within: ParentNode; readonly rule: ScopeRule }
  /**
   * Exactly one control, for the single-control scope.
   *
   * A separate shape rather than a one-element root, because there is no honest
   * `ParentNode` containing only an element that is still in the page — and
   * faking one would mean the loop *filtering* a walk, which is the thing
   * BR-002-3 forbids. The loop is handed the element instead of a place to look
   * for it.
   */
  | { readonly resolved: true; readonly only: Element; readonly rule: 'anchor-control' }
  /**
   * Nothing to fill, and a reason that is shown rather than reported as an
   * empty fill. The two reasons are distinct because BR-002-2 turns on the
   * difference: "you pointed at something I could not resolve" refuses, while
   * "there was nothing to point at" widens.
   */
  | { readonly resolved: false; readonly reason: ScopeRefusal };

/**
 * Elements that mean "you can submit this", for rule 3.
 *
 * A form is the thing you can submit, and this is the set of ways a page says
 * so. `role="button"` is deliberately absent: it is worn by every dropdown
 * toggle and disclosure triangle on the page, and admitting it would make rule 3
 * match a container that submits nothing.
 */
const SUBMIT_SELECTOR =
  'button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"], [role="form"] button';

/** Containers that count as a form-like unit when there is no anchor (A2). */
const UNIT_SELECTOR = 'form, [role="form"]';

/**
 * The root a fill should walk, given a scope and an anchor.
 *
 * `anchor` is the element the user pointed at, already resolved by the caller
 * through DD-008's three sources: right-clicked, then focused, then the last
 * control focused in this page's lifetime.
 */
export function resolveScope(
  scope: FillScope,
  document: Document,
  anchor: Element | undefined,
): Resolution {
  if (scope === 'all-inputs') {
    return { resolved: true, within: document, rule: 'whole-page' };
  }

  if (scope === 'selected-input') {
    // No superset of "one control" exists that is not a different scope, so
    // there is nothing to widen to and refusing is the only honest outcome
    // (UC-003 A2). The caller decides whether the anchor is *fillable*; this
    // only decides whether there is one.
    return anchor === undefined
      ? { resolved: false, reason: 'no-anchor' }
      : { resolved: true, only: anchor, rule: 'anchor-control' };
  }

  return anchor === undefined ? withoutAnchor(document) : fromAnchor(anchor);
}

/**
 * Rules 1–3, then rule 4's refusal (BR-002-1).
 */
function fromAnchor(anchor: Element): Resolution {
  // Rule 1. `element.form`, never `closest('form')`: HTML associates a control
  // with a form by the `form="id"` attribute as well as by containment, which is
  // how a modal or a sticky footer holds the submit button for fields outside
  // it. `closest` is wrong in both directions there (ND-3's class of fix).
  const owned = 'form' in anchor ? (anchor as { form?: unknown }).form : undefined;
  if (owned instanceof HTMLFormElement) {
    return { resolved: true, within: owned, rule: 'element-form' };
  }

  // The anchor may be the form itself — right-clicking a fieldset's legend, say.
  const declared = anchor.closest('form, [role="form"], fieldset');
  if (declared instanceof HTMLFormElement) {
    return { resolved: true, within: declared, rule: 'element-form' };
  }
  // Rule 2. The author said so without a `<form>` tag.
  if (declared !== null) {
    return { resolved: true, within: declared, rule: 'role-form' };
  }

  // Rule 3. The smallest block containing the field you pointed at and its
  // submit button — accurate, and explainable in one sentence.
  const submittable = nearestContainingSubmit(anchor);
  if (submittable !== undefined) {
    return { resolved: true, within: submittable, rule: 'submit-container' };
  }

  // Rule 4. An explicit narrowing must not be overridden (BR-002-2).
  return { resolved: false, reason: 'no-form-around-anchor' };
}

/**
 * The anchorless case (UC-002 A2).
 *
 * Widening overrides nothing here, because no narrower intent was ever stated —
 * and refusing would mean the user pressed a key and watched nothing happen.
 * Two or more units resolve to the page rather than to the largest, because a
 * superset cannot be wrong about which one was meant while a guess silently
 * fails whenever the other one was wanted.
 */
function withoutAnchor(document: Document): Resolution {
  const units = document.querySelectorAll(UNIT_SELECTOR);
  if (units.length === 1) {
    return { resolved: true, within: units[0] as Element, rule: 'only-unit' };
  }
  return { resolved: true, within: document, rule: 'whole-page' };
}

/**
 * The nearest ancestor that contains both the anchor and a submit control.
 *
 * Walks upward rather than searching downward from the document, so the answer
 * is the *smallest* such block. Stops at the document element: a root of "the
 * whole page" from this rule would be the page scope arriving under the form
 * scope's name, and BR-002-2 has a specific outcome for finding nothing.
 */
function nearestContainingSubmit(anchor: Element): Element | undefined {
  let candidate = anchor.parentElement;
  while (candidate !== null) {
    const owner = candidate.ownerDocument;
    // `<body>` and `<html>` are stopping points, not candidates. Almost every
    // page has *a* submit button somewhere, so a walk that admits the body
    // returns the whole page — which is the page scope arriving under the form
    // scope's name, and the exact widening BR-002-2 forbids. The end-to-end
    // harness caught this: with the body allowed, pointing at a control in a
    // container with no submit filled all four blocks of the fixture.
    if (candidate === owner.body || candidate === owner.documentElement) return undefined;
    if (candidate.querySelector(SUBMIT_SELECTOR) !== null) return candidate;
    candidate = candidate.parentElement;
  }
  return undefined;
}

/**
 * Tracks the element the user pointed at, for the life of the page (DD-008).
 *
 * Three sources in order: the element right-clicked, the element focused now,
 * and the last control focused during this page's lifetime. The third exists
 * because the case is common — tab through a form, click something neutral, then
 * use the shortcut — and refusing there would mean a keypress that does nothing.
 *
 * **Identity only.** This holds references to elements and never reads what they
 * contain, exactly as the "written by us" set does (BR-005-7, BR-002-5), so
 * NFR-010 is untouched. Nothing here outlives the page or reaches storage.
 */
export type AnchorWatch = {
  readonly anchor: () => Element | undefined;
  readonly release: () => void;
};

export function watchAnchor(document: Document): AnchorWatch {
  let pointed: Element | undefined;
  let lastFocused: Element | undefined;

  const onContextMenu = (event: Event): void => {
    if (event.target instanceof Element) pointed = event.target;
  };
  const onFocus = (event: Event): void => {
    if (event.target instanceof Element) lastFocused = event.target;
  };

  // Capture, so a page that stops propagation on its own handlers cannot also
  // stop us from seeing where the user pointed — the same reasoning as the user
  // input watcher in `settle.ts`.
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('focusin', onFocus, true);

  return {
    anchor: () => {
      if (pointed !== undefined && pointed.isConnected) return pointed;
      const active = document.activeElement;
      // `<body>` is what `activeElement` reports when nothing is focused, and it
      // is not something the user pointed at.
      if (active !== null && active !== document.body && active.isConnected) return active;
      return lastFocused !== undefined && lastFocused.isConnected ? lastFocused : undefined;
    },
    release: () => {
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('focusin', onFocus, true);
    },
  };
}

/**
 * Whether an exclusion or profile glob matches a URL (FR-037, FR-074, DD-005).
 *
 * The vocabulary users already know from extension match patterns: `*` stands
 * for any run of characters, everything else is literal. Deliberately not a
 * regular expression — this runs on a URL before every fill, and a second
 * catastrophic-backtracking surface there is exactly where NFR-009 is hardest
 * to guarantee.
 *
 * A pattern with no scheme matches any scheme, so `example.com/*` behaves the
 * way a user who typed a domain expects rather than silently never matching.
 */
export function matchesGlob(url: string, pattern: string): boolean {
  if (pattern === '') return false;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) || pattern.startsWith('*://');
  const expanded = hasScheme ? pattern : `*://${pattern}`;
  const source = expanded
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  try {
    return new RegExp(`^${source}$`, 'i').test(url);
  } catch {
    // A pattern that cannot compile matches nothing. Failing open here would be
    // the one direction UC-008 A1 rules out — but this is about a *pattern*
    // being unreadable, not the URL, and a broken pattern must not exclude every
    // site (UC-008 A2).
    return false;
  }
}

/** Whether any pattern excludes this URL. Returns the pattern, for the report. */
export function excludedBy(url: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesGlob(url, pattern));
}
