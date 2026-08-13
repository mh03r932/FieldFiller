/**
 * Collects candidate controls from a root.
 *
 * Takes the root explicitly and never touches the global `document` (ND-5,
 * NFR-015). That is what makes "fill this form" genuinely scoped in Phase 3,
 * what lets the engine be unit-tested against a detached fragment, and what
 * will let the same code descend into shadow roots in Phase 2 — a
 * `document`-scoped query can do none of the three.
 *
 * Phase 1 walks one frame's light DOM. Nested frames (FR-007) and open shadow
 * roots (FR-008) are Phase 2.
 */

/** Everything that could conceivably hold a value. Exclusion decides, not this. */
const CANDIDATE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

/**
 * Every candidate under `root`, in document order.
 *
 * Order matters beyond tidiness: it is the order outcomes appear in the fill
 * report, and a report whose rows do not follow the page is hard to read against
 * the form it describes.
 */
export function collectCandidates(root: ParentNode): FillableElement[] {
  return [...root.querySelectorAll<FillableElement>(CANDIDATE_SELECTOR)];
}
