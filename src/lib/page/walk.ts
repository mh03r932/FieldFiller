/**
 * Collects candidate controls from a root, descending into open shadow roots.
 *
 * Takes the root explicitly and never touches the global `document` (ND-5,
 * NFR-015). That is what makes "fill this form" genuinely scoped in Phase 3,
 * what lets the engine be unit-tested against a detached fragment, and what
 * makes shadow roots reachable at all — a `document`-scoped query cannot see
 * into one, which is why Lit, Stencil and Ionic design systems are invisible to
 * the reference (§7.3).
 *
 * Closed shadow roots stay unreachable, by anyone, permanently (C-006). That is
 * a property of the platform rather than a limitation of this walk, and it is
 * documented honestly rather than worked around.
 */

/**
 * Everything that could conceivably hold a value. Exclusion decides, not this.
 *
 * The three ARIA roles are DD-009 step C: a design system's "select" is a `div`,
 * and nothing in the native list finds it (FR-081). Adding them was gated on
 * measuring what they cost every page that has none — `scripts/spike-combobox.mjs`,
 * 2026-08-15: on a 3,591-element application page with 500 controls and no
 * combobox, **zero** extra candidates and 0.05 ms of extra selector matching,
 * which is 0.01% of NFR-001's budget. An attribute selector matches only
 * elements carrying the attribute, so a page without them pays for the match and
 * nothing downstream.
 */
const CANDIDATE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], ' +
  '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]';

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

/**
 * Every candidate under `root`, including inside open shadow roots.
 *
 * Ordering is document order within each tree, with a host's shadow content
 * following the light DOM of the tree that contains it. Perfect interleaving of
 * shadow and light content would require a flattened-tree walk, which costs more
 * than it is worth here: the order matters for how the report reads, not for
 * what gets filled.
 */
export function collectCandidates(root: ParentNode): FillableElement[] {
  const found: FillableElement[] = [];
  const seen = new Set<ParentNode>();

  const visit = (node: ParentNode): void => {
    // A host can appear once per tree, but a malformed DOM or a re-entrant
    // walk should not be able to make this loop forever.
    if (seen.has(node)) return;
    seen.add(node);

    found.push(...node.querySelectorAll<FillableElement>(CANDIDATE_SELECTOR));

    // `querySelectorAll('*')` rather than a TreeWalker: hosts are rare, the
    // scan is linear, and the alternative needs a filter callback per node.
    for (const element of node.querySelectorAll('*')) {
      const shadow = element.shadowRoot;
      if (shadow !== null) visit(shadow);
    }
  };

  visit(root);
  return found;
}
