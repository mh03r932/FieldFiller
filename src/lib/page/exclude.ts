import type { ControlKind, ExclusionReason } from '../protocol';

/**
 * Decides whether one control must be left untouched (UC-005).
 *
 * Phase 1 implements the structural checks only — steps 2 and 3 of the main
 * scenario. Hidden-field detection, honeypot heuristics, ignore patterns and
 * pre-filled exclusion arrive in Phase 2, each with the enumerated definition
 * UC-005 A3 insists on.
 */

export type Classification =
  | { readonly fillable: true; readonly kind: ControlKind }
  | { readonly fillable: false; readonly reason: ExclusionReason };

/**
 * `input` types that never receive a generated value.
 *
 * Buttons and submits would make the extension capable of activating the page's
 * own controls, which BR-001-2 forbids outright. File and image inputs cannot be
 * set programmatically at all. Hidden inputs are not user-facing.
 */
const EXCLUDED_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'file',
  'image',
  'hidden',
]);

/** `input` types Phase 1 knows how to fill. Phase 2 adds the rest. */
const TEXTUAL_INPUT_TYPES: Record<string, ControlKind> = {
  text: 'text',
  email: 'email',
  tel: 'tel',
  url: 'url',
  search: 'search',
  password: 'password',
};

/**
 * Classifies a control exactly once.
 *
 * Fail-safe by construction (BR-005-1): anything this function cannot confidently
 * classify comes back excluded. Filling a field that should have been left alone
 * is destructive and silent; skipping one is visible in the report and
 * recoverable by the user.
 *
 * The order of checks is the order of UC-005's main scenario, because the first
 * rule to fire is the reason the user is shown (BR-005-6).
 */
export function classify(element: Element): Classification {
  try {
    // Availability before kind. A disabled control is untouchable whatever it
    // is, and reporting "not a fillable kind" for a disabled text input would
    // send someone looking in the wrong place.
    if (isUnavailable(element)) {
      return { fillable: false, reason: unavailabilityReason(element) };
    }

    if (element instanceof HTMLTextAreaElement) {
      return { fillable: true, kind: 'textarea' };
    }

    if (element instanceof HTMLInputElement) {
      // `element.type` is already normalised and lower-cased by the DOM, and an
      // unknown or absent type reads as "text" — which is also how the browser
      // renders it, so following the DOM here keeps us in step with the page.
      const type = element.type;
      if (EXCLUDED_INPUT_TYPES.has(type)) {
        return { fillable: false, reason: 'not-fillable-kind' };
      }
      const kind = TEXTUAL_INPUT_TYPES[type];
      if (kind !== undefined) return { fillable: true, kind };
    }

    // Everything else — select, contenteditable, checkbox, radio, date, range —
    // is a Phase 2 control kind. Reported as an excluded kind rather than
    // silently dropped, so the report distinguishes "we left this alone" from
    // "we never saw it" (BR-005-8).
    return { fillable: false, reason: 'not-fillable-kind' };
  } catch {
    return { fillable: false, reason: 'unclassifiable' };
  }
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
