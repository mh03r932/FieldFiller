import type { ControlKind, ControlOption, FieldDescriptor } from '../protocol';
import { radioGroup } from './exclude';

/**
 * Builds a control's descriptor — what it *is*, never what it holds
 * (BR-004-10, NFR-030).
 *
 * Sources are kept separate rather than concatenated into one blob (ND-2,
 * BR-004-5). There is no rule matching yet, so nothing consumes them beyond the
 * autocomplete default and the identity hints — but the flattening is the one
 * decision that cannot be undone later: once patterns are written against a blob,
 * anchoring is
 * impossible, a class attribute can trigger a rule meant for a name, and the
 * report cannot say which source matched.
 */
export type Identity = {
  /** The radio group token, resolved by the caller against real membership. */
  readonly group?: string | undefined;
  /** The control's identity across the passes of one fill (FR-080). */
  readonly token?: string | undefined;
};

export function describe(
  element: Element,
  ref: number,
  kind: ControlKind,
  identity: Identity = {},
): FieldDescriptor {
  return {
    ref,
    ...optional('token', identity.token),
    kind,
    sources: compact({
      name: attribute(element, 'name'),
      id: element.id === '' ? undefined : element.id,
      label: labelText(element),
      placeholder: attribute(element, 'placeholder'),
      ariaLabel: attribute(element, 'aria-label'),
    }),
    ...optional('autocomplete', autocompleteToken(element)),
    constraints: compact({
      maxLength: positiveLength(element, 'maxLength'),
      minLength: positiveLength(element, 'minLength'),
      // Carried as strings because the DOM does: `min="2024-01-01"` on a date
      // input and `min="1"` on a number are both meaningful, and parsing them
      // here would force this module to know which kind it is looking at.
      min: attribute(element, 'min'),
      max: attribute(element, 'max'),
      step: attribute(element, 'step'),
      pattern: attribute(element, 'pattern'),
      required: element.hasAttribute('required') ? true : undefined,
    }),
    ...optional('options', optionsOf(element, kind)),
    ...optional('group', kind === 'radio' ? identity.group : undefined),
  };
}

/**
 * The choices a select or radio group offers.
 *
 * Disabled options are reported rather than filtered out, so the generator can
 * say *why* nothing was selectable when every option is disabled. The reference
 * tests option `i` for `disabled` and then selects a different random index
 * entirely, so it picks disabled options and can never pick option 0 (D3).
 */
function optionsOf(element: Element, kind: ControlKind): readonly ControlOption[] | undefined {
  if (kind === 'select-one' || kind === 'select-multiple') {
    return [...(element as HTMLSelectElement).options].map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled,
    }));
  }

  if (kind === 'radio') {
    return radioGroup(element as HTMLInputElement).map((radio) => ({
      value: radio.value,
      label: labelText(radio) ?? radio.value,
      disabled: radio.disabled,
    }));
  }

  return undefined;
}

/**
 * The control's label as a user reads it (BR-004-6, ND-3, FR-029, FR-066).
 *
 * `element.labels` is the whole reason this is three lines instead of a
 * `document.querySelectorAll("label[for=...]")` with CSS escaping around it. It
 * returns implicit labels — `<label>Email <input></label>` — which the reference
 * cannot see at all, needs no escaping, and works inside a shadow root where a
 * document-scoped query would look in the wrong tree entirely (BR-004-12).
 *
 * `textContent`, never `innerHTML`. Reading markup and stripping non-alphanumerics
 * turns `<label><span>Email</span></label>` into `spanemailspan`, so a rule
 * matching `/span/` fires on every wrapped label in the page (D1).
 */
function labelText(element: Element): string | undefined {
  if (!('labels' in element)) return undefined;
  const labels = (element as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  if (labels === null || labels === undefined || labels.length === 0) return undefined;

  // No null guard because `textContent` is declared with asymmetric accessors in
  // lib.dom: `get textContent(): string`, `set textContent(value: string | null)`.
  // Reading it is non-nullable — the `| null` belongs to assignment. This is a
  // property of the DOM lib's typing, not of `Element` versus `Node`, and
  // `strictNullChecks` is on regardless (WXT's base config sets `strict`).
  const text = [...labels]
    .map((label) => label.textContent.trim())
    .filter((value) => value !== '')
    .join(' ');
  return text === '' ? undefined : text;
}

/**
 * The `autocomplete` purpose, if the page declares one.
 *
 * Modern forms carry this and the reference ignores it entirely (§7.3), which is
 * a shame: `autocomplete="family-name"` is an unambiguous statement of intent,
 * where a regex on `id` is a guess. Only the last token is kept — the grammar
 * allows section and billing/shipping prefixes, and the purpose is always last.
 */
function autocompleteToken(element: Element): string | undefined {
  const value = attribute(element, 'autocomplete')?.toLowerCase();
  if (value === undefined || value === 'off' || value === 'on') return undefined;
  return value.split(/\s+/).at(-1);
}

function attribute(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `maxLength`/`minLength` read -1 when unset, which is not a constraint. */
function positiveLength(element: Element, property: 'maxLength' | 'minLength'): number | undefined {
  const value = (element as Partial<Record<typeof property, number>>)[property];
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** Drops undefined keys so a descriptor carries only what the control declares. */
function compact<T extends object>(source: T): { [K in keyof T]: NonNullable<T[K]> } {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]: NonNullable<T[K]> };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
