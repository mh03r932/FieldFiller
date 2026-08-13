/**
 * Writes a value so the page registers it, then dispatches the interaction a
 * user would really have produced (FR-013, FR-014, ND-6, BR-004-8).
 *
 * Two independent problems live here, and the reference gets both wrong.
 *
 * **The write.** Assigning `.value` on a React-controlled input updates the DOM
 * but not React's internal value tracker, so React sees no change and reverts on
 * the next render. Going through the prototype's native setter defeats the
 * tracker, which is the standard fix and the only one that works across React
 * 16/17, Vue and the rest without knowing which is present.
 *
 * **The events.** The reference fires `input`, `click`, `change` and `blur` as
 * one unconditional bundle. A synthetic `click` on a text input is a lie the page
 * may act on — it opens date pickers and trips submit handlers — and `blur`
 * without a preceding `focus` breaks React's focus pairing. All four are generic
 * `Event` rather than `InputEvent`, and `change` is constructed cancelable, which
 * it is not.
 */

type ValueElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Resolves the prototype value setter once per element type.
 *
 * Per element would be 500 descriptor lookups on a large page for an answer that
 * cannot change (ND-15's argument, applied to a different repeated cost).
 */
type ValueWriter = (element: ValueElement, value: string) => void;

const NATIVE_SETTERS = new WeakMap<object, ValueWriter | undefined>();

/**
 * Cached as a closure that applies the setter, rather than as the bare setter.
 * A property setter detached from its object is only meaningful when called with
 * an explicit receiver, and storing it bare invites exactly the mistake of
 * calling it without one.
 */
function nativeValueSetter(element: ValueElement): ValueWriter | undefined {
  const prototype = Object.getPrototypeOf(element) as object | null;
  if (prototype === null) return undefined;

  if (!NATIVE_SETTERS.has(prototype)) {
    // Detaching the setter from its prototype is the entire technique: calling
    // it with an explicit receiver is what bypasses React's value tracker.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    NATIVE_SETTERS.set(
      prototype,
      setter === undefined ? undefined : (target, value) => setter.call(target, value),
    );
  }
  return NATIVE_SETTERS.get(prototype);
}

export type ApplyOptions = {
  /** UC-004 A8: the user may write values without any interaction sequence. */
  readonly dispatchEvents: boolean;
};

/**
 * Applies one value. Throws only if the element rejects the write outright; the
 * caller isolates that per field, because one field's failure is one field's
 * failure (BR-004-11).
 */
export function applyValue(element: Element, value: string, options: ApplyOptions): void {
  if (!isValueElement(element)) {
    throw new Error(`cannot write a value to <${element.tagName.toLowerCase()}>`);
  }

  if (options.dispatchEvents) {
    // Focus first. A page watching for focus to open a suggestion list, or
    // React pairing focus with blur, needs the sequence to start where a real
    // interaction starts.
    element.focus();
  }

  const write = nativeValueSetter(element);
  if (write === undefined) {
    // No prototype setter is a genuinely unexpected DOM; assigning directly is
    // strictly worse but better than leaving the field empty, and the outcome
    // is reported either way.
    element.value = value;
  } else {
    write(element, value);
  }

  if (!options.dispatchEvents) return;

  // `InputEvent`, not `Event`: the type the browser itself would fire, carrying
  // `inputType` so a listener can tell an insertion from a deletion.
  element.dispatchEvent(
    new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }),
  );
  // `change` is not cancelable in the platform, and constructing it as if it
  // were tells a listener it can `preventDefault()` something it cannot.
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));
  element.blur();

  // Deliberately no `click`. Only controls a user actually clicks — checkboxes
  // and radios, in Phase 2 — get one.
}

function isValueElement(element: Element): element is ValueElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}
