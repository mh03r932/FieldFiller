import type { ControlKind, ExclusionReason } from '../protocol';

/**
 * Decides whether one control must be left untouched (UC-005).
 *
 * Runs in the page agent, before any value is requested, so an excluded control
 * never reaches the generator.
 *
 * The ordering follows UC-005's main scenario exactly, because the first rule to
 * fire is the reason the user is shown (BR-005-6). Someone debugging a skipped
 * field needs one answer, not a set.
 */

export type Classification =
  | { readonly fillable: true; readonly kind: ControlKind }
  | { readonly fillable: false; readonly reason: ExclusionReason };

export type ExclusionContext = {
  readonly skipHidden: boolean;
  readonly skipPreFilled: boolean;
  /** Compiled once per fill, never per field per pattern (ND-15, NFR-025). */
  readonly ignorePatterns: readonly RegExp[];
  /**
   * Controls this extension wrote during an earlier fill of this page.
   *
   * Identity only — no value is ever retained, so NFR-010 holds unchanged
   * (BR-005-7). Without this, "skip fields that already have content" would
   * silently disable filling the same page twice: two reasonable settings
   * cancelling each other out.
   */
  readonly writtenByUs: WeakSet<Element>;
  /** The control's identity, for pattern matching. Built by the caller. */
  readonly identity: readonly string[];
};

const EXCLUDED_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'image', 'hidden']);

/** `input` types that carry a textual or scalar value. */
const INPUT_KINDS: Record<string, ControlKind> = {
  text: 'text',
  email: 'email',
  tel: 'tel',
  url: 'url',
  search: 'search',
  password: 'password',
  number: 'number',
  range: 'range',
  date: 'date',
  'datetime-local': 'datetime-local',
  month: 'month',
  week: 'week',
  time: 'time',
  color: 'color',
  checkbox: 'checkbox',
  radio: 'radio',
};

/** Everything decidable without the control's identity: steps 2–3, 6 and 7. */
export type StructuralContext = Omit<ExclusionContext, 'ignorePatterns' | 'identity'>;

/**
 * The checks that do not need identity.
 *
 * Split from the pattern check because identity is most of the descriptor, and
 * building it is only worth doing for a control that survives this far
 * (BR-005-4 — the ordering is for cost, not for meaning). Running the whole
 * classification twice would repeat `getBoundingClientRect` and
 * `getComputedStyle` per control, which is exactly the sort of per-element cost
 * NFR-001's 500-controls-in-500 ms budget cannot afford.
 */
export function classifyStructural(element: Element, context: StructuralContext): Classification {
  try {
    if (isUnavailable(element)) return excluded(unavailabilityReason(element));

    const kind = kindOf(element);
    if (kind === undefined) return excluded('not-fillable-kind');

    // Step 6: hidden, which is where honeypots are caught.
    if (context.skipHidden && !isPerceivable(element)) return excluded('hidden');

    // Step 7: pre-filled. A custom combobox gets its own reason, because
    // `pre-filled` would assert that we read it and found content, and the
    // reason we are excluding it is that we cannot read it at all.
    if (context.skipPreFilled && holdsUserContent(element, kind, context)) {
      return excluded(kind === 'combobox' ? 'content-unknown' : 'pre-filled');
    }

    return { fillable: true, kind };
  } catch {
    // BR-005-1: when classification is uncertain or throws, the control is
    // excluded. Filling a field that should have been left alone is destructive
    // and silent; skipping one is visible in the report and recoverable.
    return excluded('unclassifiable');
  }
}

/**
 * Where a fill's exclusion matching goes, pattern by pattern (NFR-032).
 *
 * The shape `MatchCost` has on the rules side, and deliberately so — the two
 * sites answer the same requirement and there is no reason for them to disagree
 * about how. It is declared here rather than imported from `rules/match.ts`
 * because a value import from that module would pull the whole rule matcher into
 * the page agent's bundle (NFR-003), and this is a record of four lines.
 *
 * A plain object rather than a `Map` because the fill loop's is the one that
 * crosses `runtime.sendMessage`, and one shape all the way through is one fewer
 * conversion to get wrong.
 */
export type PatternCost = {
  readonly now: () => number;
  readonly ms: Record<string, number>;
};

function charge(cost: PatternCost, source: string, at: number): void {
  cost.ms[source] = (cost.ms[source] ?? 0) + (cost.now() - at);
}

/**
 * Step 5, once identity exists.
 *
 * `lastIndex` is reset per test because a pattern compiled with /g would
 * otherwise carry state between fields and match every other one.
 *
 * One clock pair per *pattern*, and only when an accumulator is supplied —
 * `selectRule`'s arrangement, for `selectRule`'s reasons. The pattern is what
 * the user can delete, so the pattern is what the cost has to be charged to; a
 * figure for the call as a whole would say a fill was slow without saying which
 * of the patterns to look at. Charging only what the loop actually reaches
 * matters here in a way it does not there: this returns on the first match, so
 * a pattern after that match cost nothing and must be charged nothing.
 */
export function matchesIgnorePattern(
  identity: readonly string[],
  patterns: readonly RegExp[],
  cost?: PatternCost,
): boolean {
  for (const pattern of patterns) {
    const at = cost?.now();
    for (const source of identity) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) {
        if (cost !== undefined && at !== undefined) charge(cost, pattern.source, at);
        return true;
      }
    }
    if (cost !== undefined && at !== undefined) charge(cost, pattern.source, at);
  }
  return false;
}

/**
 * The full classification, in UC-005's order. Used where identity is already
 * known — including the tests, which is why it exists rather than being inlined
 * into the agent.
 */
export function classify(element: Element, context: ExclusionContext): Classification {
  if (matchesIgnorePattern(context.identity, context.ignorePatterns)) {
    // Step 5 sits before hidden and pre-filled in the main scenario, and the
    // first rule to fire is the reason reported (BR-005-6) — so an ignored field
    // reads as ignored even when it is also hidden.
    const structural = classifyStructural(element, context);
    if (!structural.fillable && structural.reason !== 'hidden' && structural.reason !== 'pre-filled') {
      return structural;
    }
    return excluded('ignored-pattern');
  }
  return classifyStructural(element, context);
}

function excluded(reason: ExclusionReason): Classification {
  return { fillable: false, reason };
}

function kindOf(element: Element): ControlKind | undefined {
  if (element instanceof HTMLTextAreaElement) return 'textarea';

  if (element instanceof HTMLSelectElement) {
    return element.multiple ? 'select-multiple' : 'select-one';
  }

  if (element instanceof HTMLInputElement) {
    if (EXCLUDED_INPUT_TYPES.has(element.type)) return undefined;
    // An unknown or absent type reads as "text" through the DOM, which is also
    // how the browser renders it — following the DOM keeps us in step with the
    // page rather than with the attribute.
    return INPUT_KINDS[element.type];
  }

  if (element instanceof HTMLElement && element.isContentEditable) return 'contenteditable';
  if (isCustomCombobox(element)) return 'combobox';
  return undefined;
}

/**
 * A control that behaves as a select without being one (FR-081, UC-034 A9).
 *
 * Native elements are excluded by construction, and that is the whole subtlety:
 * `<input role="combobox">` is the ARIA autocomplete pattern — a text input with
 * a popup attached — and it is filled by typing into it, which the `input`
 * branch above already does correctly. Treating it as a combobox would replace a
 * working fill with an interaction ladder that has to be verified.
 *
 * `aria-haspopup="listbox"` catches the trigger-button shape, where the role
 * sits on the popup rather than on the thing you click.
 */
function isCustomCombobox(element: Element): boolean {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return false;
  }

  const role = element.getAttribute('role');
  return (
    role === 'combobox' ||
    role === 'listbox' ||
    element.getAttribute('aria-haspopup') === 'listbox'
  );
}

function isUnavailable(element: Element): boolean {
  return (
    ('disabled' in element && element.disabled === true) ||
    ('readOnly' in element && element.readOnly === true) ||
    element.getAttribute('aria-disabled') === 'true'
  );
}

function unavailabilityReason(element: Element): ExclusionReason {
  if ('disabled' in element && element.disabled === true) return 'disabled';
  if ('readOnly' in element && element.readOnly === true) return 'readonly';
  return 'aria-disabled';
}

/**
 * Whether a sighted user could perceive the control (UC-005 A3, BR-005-5).
 *
 * This list is the definition, not examples of it. "Honeypot avoidance" without
 * an enumerated set becomes whatever the implementer judged on the day.
 *
 * The reference tests `offsetWidth`/`offsetHeight` and `visibility` only, which
 * misses full transparency and off-screen positioning — the two most common
 * honeypot techniques, so it fills exactly the fields the feature exists to
 * avoid (ND-16).
 */
function isPerceivable(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;

  // `checkVisibility` covers display:none, visibility:hidden, content-visibility
  // and the hidden attribute in one call, and is the browser's own answer rather
  // than our reconstruction of it.
  if (typeof element.checkVisibility === 'function') {
    if (!element.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style !== undefined) {
    // `!== ''` first, because `Number('') === 0`. A computed style that does not
    // state an opacity means "not stated", not "fully transparent" — and a
    // browser that returned the empty string here would otherwise make this
    // function reject every control on the page, silently turning "skip
    // honeypots" into "fill nothing". Browsers return "1"; the test DOM returns
    // "", which is how this was found.
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    // `clip-path: inset(100%)` and the legacy `clip: rect(0,0,0,0)` are both
    // ways to render a control invisible while keeping it in the layout.
    if (style.clipPath === 'inset(100%)') return false;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return false;
  }

  // Positioned outside the document. Checked against the scrollable extent
  // rather than the viewport, so a field merely below the fold still counts as
  // perceivable — the user can scroll to it.
  const documentElement = element.ownerDocument.documentElement;
  const absoluteLeft = rect.left + (element.ownerDocument.defaultView?.scrollX ?? 0);
  const absoluteTop = rect.top + (element.ownerDocument.defaultView?.scrollY ?? 0);
  if (absoluteLeft + rect.width < 0 || absoluteTop + rect.height < 0) return false;
  if (absoluteLeft > documentElement.scrollWidth || absoluteTop > documentElement.scrollHeight) {
    return false;
  }

  // Hidden from assistive technology *and* removed from the tab order. Either
  // alone is too weak: `aria-hidden` appears on decorative wrappers, and
  // `tabindex="-1"` on controls a script focuses programmatically.
  if (element.getAttribute('aria-hidden') === 'true' && element.tabIndex < 0) return false;

  return true;
}

/**
 * Whether the control already holds content the *user* put there (step 7).
 *
 * Two things are deliberately not content: a checkbox's checked state
 * (BR-005-2), because an unchecked box is indistinguishable from an untouched
 * one; and anything this extension wrote earlier on this page (BR-005-7).
 */
function holdsUserContent(element: Element, kind: ControlKind, context: StructuralContext): boolean {
  if (context.writtenByUs.has(element)) return false;

  switch (kind) {
    case 'checkbox':
      return false;

    case 'combobox':
      // We cannot tell, and BR-005-1 says which way to fail. A native control
      // exposes its value; a custom one exposes rendered text, and a chosen
      // answer and a placeholder are the same shape of text — "United Kingdom"
      // and "Select a country" are both non-empty strings in a `<span>`.
      //
      // With the toggle on, the user has asked for content to be left alone, so
      // a control we cannot read is left alone. It is reported as
      // `content-unknown` rather than `pre-filled` by the caller, because
      // `pre-filled` would claim we looked and found something.
      return true;

    case 'radio':
      // A1: the group is answered, not the individual button. Scoped to the
      // owning form, because two forms on one page may legitimately use the same
      // group name and the reference lets them interfere (ND-5, BR-005-3).
      return radioGroup(element as HTMLInputElement).some(
        (radio) => radio.checked && !context.writtenByUs.has(radio),
      );

    case 'select-one':
    case 'select-multiple': {
      const select = element as HTMLSelectElement;
      return [...select.selectedOptions].some((option) => option.value !== '');
    }

    case 'contenteditable':
      return (element.textContent.trim()) !== '';

    default:
      return 'value' in element && String(element.value) !== '';
  }
}

/**
 * Every radio sharing this control's name within its own form.
 *
 * `form.elements` rather than a document query: a radio with no owning form has
 * no such boundary, and its group is then every same-named radio in the
 * document — which is what the browser itself does when deciding which buttons
 * are mutually exclusive (BR-005-3).
 */
export function radioGroup(radio: HTMLInputElement): HTMLInputElement[] {
  const name = radio.name;
  if (name === '') return [radio];

  const scope: ParentNode = radio.form ?? radio.getRootNode() as ParentNode;
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (candidate) => candidate.name === name,
  );
}
