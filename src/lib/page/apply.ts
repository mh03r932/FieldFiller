import type { FieldValue } from '../protocol';

/**
 * The values that are *written*, as opposed to driven.
 *
 * A custom combobox is not written to — it is opened, chosen from and verified
 * through the interactions a user would make (`combobox.ts`, BR-034-9), and it
 * is asynchronous because the page renders its popup on the next frame. Excluding
 * it here makes routing it elsewhere a compile error rather than a convention,
 * which matters because the shortcut — writing the hidden input behind the
 * component — is one line and looks like it works.
 */
export type WritableValue = Extract<FieldValue, { as: 'text' | 'choice' | 'toggle' | 'skip' }>;

/**
 * Writes a value so the page registers it, then dispatches the interaction a
 * user would really have produced (FR-013, FR-014, ND-6, BR-004-8).
 *
 * Three independent problems live here, and the reference gets all three wrong.
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
 *
 * **The readback.** Having written is not the same as having been written to.
 * The reference assumes the two are identical and reports every attempt as a
 * success, so a page that rejects, reverts or has moved on since the control was
 * described still produces a confident count of fields it did not fill.
 * `verifyWrite` below asks the control what it actually holds (FR-076).
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

type ApplyOptions = {
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
export function applyValue(element: Element, value: WritableValue, options: ApplyOptions): void {
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

/** Whether a write survived the page's reaction to it (FR-076, BR-034-4). */
type WriteVerification =
  | { readonly landed: true }
  | { readonly landed: false; readonly reason: string };

const LANDED: WriteVerification = { landed: true };

/**
 * Reads a control back to find out whether the value written to it took
 * (FR-076, UC-034 step 1).
 *
 * Writing is not the same as having written. A page may reject the value, revert
 * it from a handler, or have rewritten the control's options between the moment
 * they were described and the moment they were used — and in every one of those
 * cases the reference, and this engine before now, reports a confident "filled"
 * for a control holding nothing. That is the silent failure UC-034 exists to
 * remove, and every later part of DD-009 depends on this answer: a loop that
 * cannot tell whether a write survived cannot decide what to fill again.
 *
 * **Never string equality** (BR-034-4). A number field given `007` holds `7`; a
 * colour normalises case; a length-limited field truncates; a reference field
 * uppercases itself; a currency mask inserts separators. Every one of those
 * accepted the value. Comparing what came back with what went in would report a
 * correctly filled page as a wall of failures — so what is asked instead is
 * whether the control holds something its own kind can accept.
 *
 * Exactness is used only where the platform makes it available: a checkbox is in
 * the state it was set to, and a select holds the options that were chosen.
 *
 * Called immediately after the write, which is deliberate: `applyValue`
 * dispatches its events synchronously, so a page that reverts us from a handler
 * has already done so by the time this runs. It is not the whole answer — a page
 * that reverts on a timer is invisible here, which is why UC-034 verifies a
 * second time when the fill ends (BR-034-2) — but it is the half that needs no
 * loop, and it is correct on its own.
 *
 * Nothing read here is retained, returned or reported: the reason strings below
 * describe the control, never its contents (BR-034-11, NFR-010, NFR-030).
 */
export function verifyWrite(element: Element, value: WritableValue): WriteVerification {
  switch (value.as) {
    case 'skip':
      return LANDED;

    case 'toggle':
      if (!(element instanceof HTMLInputElement)) return { landed: false, reason: 'not-a-toggle' };
      return element.checked === value.checked
        ? LANDED
        : { landed: false, reason: 'toggle-did-not-change' };

    case 'choice':
      return verifyChoice(element, value.values);

    case 'text':
      return verifyText(element);
  }
}

function verifyChoice(element: Element, values: readonly string[]): WriteVerification {
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    return element.checked === values.includes(element.value)
      ? LANDED
      : { landed: false, reason: 'radio-did-not-change' };
  }

  if (!(element instanceof HTMLSelectElement)) return { landed: false, reason: 'not-a-choice' };

  // Exact, because a select can be exact. Compared as sets of values rather than
  // by count: a multi-select that took two of the three options asked for has
  // not been filled as instructed, and the difference matters to the user.
  const wanted = new Set(values);
  const selected = new Set([...element.selectedOptions].map((option) => option.value));
  selected.delete('');

  if (selected.size === wanted.size && [...wanted].every((entry) => selected.has(entry))) {
    return LANDED;
  }

  // The common cause, and the one worth naming: the page rewrote the options
  // between describing the control and filling it, so the chosen value no longer
  // exists to be chosen. This is UC-034 A1 — the case the whole decision exists
  // for — and naming it here is what lets a user see it before the loop that
  // fixes it is built.
  const available = new Set([...element.options].map((option) => option.value));
  const missing = [...wanted].some((entry) => !available.has(entry));
  return { landed: false, reason: missing ? 'options-changed' : 'selection-did-not-take' };
}

function verifyText(element: Element): WriteVerification {
  if (element instanceof HTMLElement && element.isContentEditable) {
    return element.textContent.trim() === ''
      ? { landed: false, reason: 'value-did-not-take' }
      : LANDED;
  }

  if (!isValueElement(element)) return { landed: false, reason: 'not-a-value-control' };

  // Emptiness is the test, not equality. A control the page cleared holds
  // nothing; a control the page reformatted holds something.
  if (element.value === '') return { landed: false, reason: 'value-did-not-take' };

  // The browser's own judgement on whether the contents suit the control — an
  // unparseable date, a malformed email, a number outside its range. Asking the
  // platform is better than reconstructing its rules, and it is the same
  // reasoning that put `checkVisibility` in the exclusion path rather than a
  // hand-rolled equivalent.
  //
  // `validity.valueMissing` is deliberately not treated as a failure of the
  // write: it means the control is `required` and empty, which the emptiness
  // check above has already answered more precisely.
  //
  // This does fold two different things into one outcome — a value the page
  // would reject and a write that did not take — and UC-034 A6 settles which
  // wins: both are reported failed, and neither is retried by a later pass on
  // that basis, because an unfillable value is a generation defect and passes
  // would only hide it.
  //
  // Note for anyone testing this: `tooLong` and `tooShort` apply only to a value
  // the user dirtied, so a browser calls an over-long programmatic write valid.
  // happy-dom sets the flags regardless, which is why the unit tests do not
  // cover that case.
  if (typeof element.checkValidity === 'function' && !element.checkValidity()) {
    return { landed: false, reason: 'invalid-for-control' };
  }

  return LANDED;
}
