/**
 * The form controls every options section is built from.
 *
 * Extracted from the rule editor when the Phase 4 settings sections were built:
 * six of these seven functions existed there already, and the alternative was a
 * second copy that would drift. A hint that renders as a `<span>` in one section
 * and as a `title` in another is not a variation the user reads as deliberate.
 *
 * Plain DOM and no dependencies, for the reason the rest of this extension has
 * none: G4's verifiable build is worth more than the convenience, and a settings
 * page is not where a framework earns its keep.
 *
 * Nothing here resolves a catalog key. Every function takes text already
 * resolved, so this module has no import-time dependency on `browser.i18n`
 * being live and can be exercised by a test that never mocks it.
 */

/** A labelled control with an optional hint beneath it. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const text = document.createElement('span');
  text.textContent = label;
  wrapper.append(text, control);
  if (hint !== undefined) {
    const help = document.createElement('span');
    help.className = 'hint';
    help.textContent = hint;
    wrapper.append(help);
  }
  return wrapper;
}

export function textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

export function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.addEventListener('input', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return input;
}

/**
 * A number input where empty means "unset", not zero.
 *
 * The distinction is the whole of UC-022's length caps: no cap and a cap of zero
 * are opposite instructions, and a plain `numberInput` cannot express the first
 * — it ignores anything unparseable, so clearing the box would silently leave
 * the previous cap in force while showing nothing.
 *
 * `min` is applied by the caller through the DOM attribute for the browser's own
 * validation; the guard here is what actually keeps a nonsense value out of
 * storage, because typing is not the only way a value arrives.
 */
export function optionalNumberInput(
  value: number | undefined,
  onChange: (value: number | undefined) => void,
  min = 1,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.value = value === undefined ? '' : String(value);
  input.addEventListener('input', () => {
    if (input.value.trim() === '') {
      onChange(undefined);
      return;
    }
    const parsed = Number(input.value);
    if (Number.isInteger(parsed) && parsed >= min) onChange(parsed);
  });
  return input;
}

export function textArea(value: string, onChange: (value: string) => void): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.rows = 4;
  area.value = value;
  area.addEventListener('input', () => onChange(area.value));
  return area;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrapper.append(box, document.createTextNode(` ${label}`));
  if (hint !== undefined) {
    const help = document.createElement('span');
    help.className = 'hint';
    help.textContent = hint;
    wrapper.append(help);
  }
  return wrapper;
}

export function select(
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
  chosen: string,
  onChange: (value: string) => void,
  hint?: string,
): HTMLElement {
  const control = document.createElement('select');
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = value === chosen;
    control.append(option);
  }
  control.addEventListener('change', () => onChange(control.value));
  return field(label, control, hint);
}

/**
 * Puts the focus somewhere deliberate after a rebuild.
 *
 * Every section here re-renders with `replaceChildren`, so a rebuild destroys
 * the control that triggered it and the focus lands on `<body>` unless something
 * says otherwise. For a keyboard or screen-reader user that means starting again
 * from the top of the page after every add, remove and toggle (WCAG 2.4.3,
 * NFR-019).
 */
export function focusIn(root: ParentNode, selector: string): boolean {
  const target = root.querySelector<HTMLElement>(selector);
  target?.focus();
  // Reported rather than assumed, so a caller with a fallback can tell whether
  // it is needed. Removing the last row of a list is the case that matters:
  // there is no next row to aim at, and without an answer here the focus is
  // silently dropped on `<body>`.
  return target !== null;
}
