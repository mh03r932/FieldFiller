import type { ControlKind, FieldDescriptor } from '../protocol';

/**
 * Builds a control's descriptor — what it *is*, never what it holds
 * (BR-004-10, NFR-030).
 *
 * Sources are kept separate rather than concatenated into one blob (ND-2,
 * BR-004-5). Phase 1 has no rule matching, so nothing consumes them yet beyond
 * the autocomplete default — but the flattening is exactly the decision that
 * cannot be undone later: once patterns are written against a blob, anchoring is
 * impossible, a class attribute can trigger a rule meant for a name, and the
 * report cannot say which source matched.
 */
export function describe(element: Element, ref: number, kind: ControlKind): FieldDescriptor {
  return {
    ref,
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
    }),
  };
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
