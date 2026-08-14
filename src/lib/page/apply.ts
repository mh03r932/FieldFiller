import type { FieldValue } from '../protocol';

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
 * one unconditional bundle for every control. A synthetic `click` on a text
 * input is a lie the page may act on — it opens date pickers and trips submit
 * handlers — and `blur` without a preceding `focus` breaks React's focus
 * pairing. All four are generic `Event` rather than `InputEvent`, and `change`
 * is constructed cancelable, which it is not.
 *
 * So the sequence here is per kind: text-like controls are typed into, and
 * checkboxes and radios are *clicked*, because that is what a user does to them.
 */

type ValueElement = HTMLInputElement | HTMLTextAreaElement;
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
 * Applies one value to one control.
 *
 * Throws only if the control rejects the write outright; the caller isolates
 * that per field, because one field's failure is one field's failure
 * (BR-004-11).
 */
export function applyValue(element: Element, value: FieldValue, options: ApplyOptions): void {
  switch (value.as) {
    case 'skip':
      return;
    case 'toggle':
      return applyToggle(element, value.checked, options);
    case 'choice':
      return applyChoice(element, value.values, options);
    case 'text':
      return applyText(element, value.value, options);
  }
}

function applyText(element: Element, value: string, options: ApplyOptions): void {
  // A7 / D8: a content-editable region gets the same event path and the same
  // exclusion checks as any other control. The reference skips both, so it
  // overwrites rich-text editors even with "ignore fields with content" on, and
  // React, Quill and ProseMirror never see the change.
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (options.dispatchEvents) element.focus();
    element.textContent = value;
    if (options.dispatchEvents) {
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }),
      );
      element.blur();
    }
    return;
  }

  if (!isValueElement(element)) {
    throw new Error(`cannot write a value to <${element.tagName.toLowerCase()}>`);
  }

  // Focus first. A page watching for focus to open a suggestion list, or React
  // pairing focus with blur, needs the sequence to start where a real
  // interaction starts.
  if (options.dispatchEvents) element.focus();

  const write = nativeValueSetter(element);
  if (write === undefined) {
    // No prototype setter is a genuinely unexpected DOM; assigning directly is
    // strictly worse but better than leaving the field empty, and the outcome is
    // reported either way.
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

  // Deliberately no `click` — see `applyToggle` for the controls that get one.
}

/**
 * Checkboxes and radios, which a user reaches by clicking.
 *
 * This is the one place a synthetic `click` is honest: it is the interaction the
 * control actually receives, and dispatching it lets a page's own click handler
 * run exactly as it would for a real user. The state is set first so a handler
 * reading `checked` sees the value the click produced, which is the order the
 * browser uses.
 */
function applyToggle(element: Element, checked: boolean, options: ApplyOptions): void {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`cannot toggle <${element.tagName.toLowerCase()}>`);
  }

  if (element.checked === checked) {
    // Already in the requested state. Dispatching anyway would tell the page
    // about a change that did not happen.
    return;
  }

  if (!options.dispatchEvents) {
    element.checked = checked;
    return;
  }

  element.focus();
  // `click()`, not an assignment followed by a synthetic click event. A click on
  // a checkbox has activation behaviour: the browser *toggles* it as part of
  // dispatching. Setting the state first and then clicking therefore toggles it
  // straight back, leaving the box in exactly the state we were asked to change
  // it from — silently, since nothing throws.
  //
  // Letting the click do the toggling is also the more faithful simulation: the
  // browser fires click, input and change itself, in its own order, and a page
  // that calls `preventDefault()` keeps its checkbox unchanged, which is the
  // behaviour a real user would get.
  element.click();
  element.blur();
}

/** Selects and radio groups. */
function applyChoice(element: Element, values: readonly string[], options: ApplyOptions): void {
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    // A radio group is filled by ticking one member. The descriptor batch
    // contains every member, so only the one whose value was chosen acts.
    return applyToggle(element, values.includes(element.value), options);
  }

  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`cannot choose an option on <${element.tagName.toLowerCase()}>`);
  }

  if (options.dispatchEvents) element.focus();

  const wanted = new Set(values);
  for (const option of element.options) {
    option.selected = wanted.has(option.value);
  }

  if (!options.dispatchEvents) return;
  // A select produces `input` then `change` when the user picks an option, and
  // no click — the click landed on the popup, which is not part of the document.
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: false }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));
  element.blur();
}

function isValueElement(element: Element): element is ValueElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}
