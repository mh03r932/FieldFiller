import type { FillScope, FillTrigger, ScopeRefusal, ScopeRule } from '../protocol';

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

/**
 * Elements that hold another browsing context, and so can never be an anchor.
 *
 * Focus inside one of these reports the container in the *parent* document, and
 * a shortcut is routed to the top frame, so without this the anchor for
 * "fill this form" while typing in an iframe was the `<iframe>` itself.
 */
const FRAME_SELECTOR = 'iframe, frame, embed, object';

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
 * Tracks where a fill should be anchored, for the life of the page (DD-008).
 *
 * Three sources, and **which of them apply depends on how the fill was
 * invoked** (UC-002 A1): a menu fill may use the element right-clicked, then
 * what is focused now, then the last control focused in this page's lifetime; a
 * shortcut or toolbar fill starts at the second, because it was not aimed at
 * anything. The third exists because the case is common — tab through a form,
 * click something neutral, then use the shortcut — and refusing there would mean
 * a keypress that does nothing.
 *
 * Letting the right-clicked element apply to every trigger is what this used to
 * do, and it did not degrade gracefully: the element outlives the menu that
 * selected it, so one right-click redirected every later shortcut on the page.
 *
 * **Identity only.** This holds references to elements and never reads what they
 * contain, exactly as the "written by us" set does (BR-005-7, BR-002-5), so
 * NFR-010 is untouched. Nothing here outlives the page or reaches storage.
 */
export type AnchorWatch = {
  readonly anchor: (trigger: FillTrigger) => Element | undefined;
  readonly release: () => void;
};

export function watchAnchor(document: Document): AnchorWatch {
  let pointed: Element | undefined;
  let lastFocused: Element | undefined;

  /**
   * Whether an element can be an anchor at all, whichever source offered it.
   *
   * `<body>` and `<html>` are what a right-click on blank background and an
   * unfocused document report, and neither is something the user pointed *at*.
   * `<body>` in particular is connected for the life of the page, so recording
   * it once made it outrank every other source forever.
   *
   * A frame element is what `activeElement` reports when focus is *inside* that
   * frame — the user is typing in the child document, and the element naming it
   * is not the thing they are working on. Left in, "fill this input" reported an
   * `<iframe>` as an unfillable control, and "fill this form" resolved rule 3
   * around it and filled a form in the top document instead. Rejecting it means
   * the form scope widens (A2) and the control scope refuses, which are both
   * answers the user can read.
   */
  const usable = (element: Element): boolean =>
    element !== document.body &&
    element !== document.documentElement &&
    !element.matches(FRAME_SELECTOR);

  const onContextMenu = (event: Event): void => {
    // A page can dispatch its own `contextmenu` at any element it likes. Between
    // a real right-click and the user choosing our menu item, that would move
    // the anchor to the page's choice — a narrow window, but the pointer is the
    // one source the user cannot see, so it is the one worth closing.
    //
    // `focusin` below is deliberately not guarded the same way: a page calling
    // `element.focus()` produces a *trusted* event, because focus really did
    // move. There is nothing to tell apart there, and pretending otherwise would
    // buy a guard that stops nothing.
    if (event.isTrusted !== true) return;
    if (event.target instanceof Element && usable(event.target)) pointed = event.target;
  };
  const onFocus = (event: Event): void => {
    if (event.target instanceof Element && usable(event.target)) lastFocused = event.target;
  };

  // Capture, so a page that stops propagation on its own handlers cannot also
  // stop us from seeing where the user pointed — the same reasoning as the user
  // input watcher in `settle.ts`.
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('focusin', onFocus, true);

  return {
    anchor: (trigger) => {
      // Only a menu fill may use the pointer, and only because the menu it came
      // from was opened over that element moments earlier. A shortcut is not
      // aimed at anything (UC-002 A1), so consulting the last right-click there
      // is not a fallback but a wrong answer that happens to be available —
      // and, since the pointer survives as long as its element does, an answer
      // that stays wrong for the life of the page.
      if (trigger === 'menu' && pointed !== undefined && pointed.isConnected) return pointed;
      const active = document.activeElement;
      if (active !== null && active.isConnected && usable(active)) return active;
      return lastFocused !== undefined && lastFocused.isConnected ? lastFocused : undefined;
    },
    release: () => {
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('focusin', onFocus, true);
    },
  };
}

/**
 * Splits a URL or pattern into everything up to the end of the authority, and
 * the path that follows — with any `:port` removed from the authority.
 *
 * Extension match patterns have no port: the host is a host, and matching
 * ignores the port the page is served on. Ours claimed that vocabulary and did
 * not implement it — `localhost/*` expanded to a matcher that
 * `http://localhost:3000/` failed, so an exclusion on any ported URL was
 * accepted, listed, and silently inert. Silently is the whole problem: an
 * exclusion that fails to match fails **open**, and a pattern matching nothing
 * looks exactly like a page nobody excluded.
 *
 * Only a trailing `:digits` goes: `[::1]:8080` keeps its brackets, and
 * `user:pass@host` has no port to lose.
 */
function splitAuthority(value: string): { readonly head: string; readonly path: string } {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return { head: value, path: '' };

  const authorityStart = schemeEnd + '://'.length;
  const pathStart = value.indexOf('/', authorityStart);
  const authority = pathStart === -1 ? value.slice(authorityStart) : value.slice(authorityStart, pathStart);

  return {
    head: value.slice(0, authorityStart) + authority.replace(/:\d+$/, ''),
    path: pathStart === -1 ? '' : value.slice(pathStart),
  };
}

/** A URL with its port dropped and a path guaranteed, so `/…` always has something to match. */
function normaliseUrl(url: string): string {
  const { head, path } = splitAuthority(url);
  // `http://localhost` and `http://localhost/` are the same page, and only the
  // second is what `example.com/*` is written against.
  return head + (path === '' ? '/' : path);
}

/**
 * A pattern with its port dropped, and a bare host read as covering any path.
 *
 * The port a user types is read as part of the host and then dropped, so
 * `localhost:3000/*` covers every port on `localhost`. Chrome would call that
 * pattern malformed; voiding it would restore the silent failure this
 * normalisation exists to remove, and widening an exclusion is safe in a way
 * that voiding one is not. What a user cannot express is "this host on this port
 * only" — a deliberate limit, recorded in BR-008-6.
 *
 * A bare host with no path is read the same generous way: `example.com` means
 * `example.com/*`, not "the root and nothing else". A user who types a domain
 * into a field labelled "excluded domains" means the domain.
 */
function normalisePattern(pattern: string): string {
  const { head, path } = splitAuthority(pattern);
  return head + (path === '' ? '/*' : path);
}

/**
 * Whether a glob's literal segments appear in order, without backtracking.
 *
 * `*` stands for any run of characters and every other character is literal, so
 * a pattern is a list of literals that must appear in order — anchored at each
 * end unless the pattern starts or ends with a star. Each literal is then found
 * with one forward `indexOf` from where the previous one ended, and taking the
 * earliest occurrence is safe: a later one can only match a suffix of what an
 * earlier one already covers, so nothing is lost by not going back.
 *
 * **Not a regular expression, and the difference is the point.** Translating
 * `*` to `.*` was the obvious implementation and it is the textbook
 * catastrophic-backtracking shape: `*a*a*a*a*a*a*a*a*a*z` against a URL ending
 * in a run of `a`s made the engine try every way to divide the run between the
 * stars. Measured before this was replaced, that pattern took 3 ms at 20
 * trailing characters, 3.2 s at 40 and 33 s at 50 — on a string a page can make
 * arbitrarily long, in a check that runs in the background before every fill
 * (BR-008-1). The module comment claimed to be avoiding exactly this and was
 * describing an intention rather than the code.
 *
 * Patterns can only be written into storage by hand today, so nothing reachable
 * exploits it. Phase 4 gives them an editor and Phase 6 gives them import and
 * sync, and a shared configuration that stops every fill in the browser is not a
 * failure worth shipping the ingredients for.
 */
function segmentsMatch(text: string, pattern: string): boolean {
  const parts = pattern.split('*');
  // No star at all: the pattern is one literal, and must be the whole string.
  if (parts.length === 1) return text === pattern;

  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  const middle = parts.slice(1, -1);

  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  // Guards the case where the anchors overlap: `ab*ba` must not match `aba` by
  // letting the prefix and suffix share a character.
  if (text.length < first.length + last.length) return false;

  let at = first.length;
  const limit = text.length - last.length;
  for (const part of middle) {
    if (part === '') continue;
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > limit) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether an exclusion or profile glob matches a URL (FR-037, FR-074, DD-005).
 *
 * The vocabulary users already know from extension match patterns: `*` stands
 * for any run of characters, everything else is literal, and the port takes no
 * part on either side (see `withoutPort`). Deliberately not a regular
 * expression — this runs on a URL before every fill, and a second
 * catastrophic-backtracking surface there is exactly where NFR-009 is hardest to
 * guarantee. `segmentsMatch` is what makes that true rather than intended.
 *
 * Case is folded rather than delegated to a regex flag, which is the only thing
 * the `i` flag was doing. Hosts and schemes are ASCII, and the path is compared
 * the same way it always was.
 *
 * A pattern with no scheme matches any scheme, so `example.com/*` behaves the
 * way a user who typed a domain expects rather than silently never matching.
 */
export function matchesGlob(url: string, pattern: string): boolean {
  if (pattern === '') return false;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) || pattern.startsWith('*://');
  const expanded = normalisePattern(hasScheme ? pattern : `*://${pattern}`);

  return segmentsMatch(normaliseUrl(url).toLowerCase(), expanded.toLowerCase());
}

/** Whether any pattern excludes this URL. Returns the pattern, for the report. */
export function excludedBy(url: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesGlob(url, pattern));
}
