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
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  // The label points at the control by id rather than wrapping it, and the hint
  // sits outside the label and is pointed at with `aria-describedby`. When the
  // label wrapped everything, a multi-sentence hint was part of the control's
  // accessible *name* — read out in full every time a screen-reader user
  // reached the control, and never the one-line name the sighted reader sees
  // (WCAG 2.5.3, NFR-019). The grid is unchanged: label row, control row,
  // hint row.
  const text = document.createElement('label');
  text.textContent = label;
  if (control instanceof HTMLElement && 'labels' in control) {
    control.id = nextId('ff-control');
    text.htmlFor = control.id;
  }
  wrapper.append(text, control);

  if (hint !== undefined) {
    const help = document.createElement('span');
    help.className = 'hint';
    help.textContent = hint;
    help.id = nextId('ff-hint');
    wrapper.append(help);
    describeWith(control, help.id);
  }
  return wrapper;
}

/** Appends to `aria-describedby` rather than overwriting, in case a caller set one. */
function describeWith(control: HTMLElement, id: string): void {
  const existing = control.getAttribute('aria-describedby');
  control.setAttribute('aria-describedby', existing === null ? id : `${existing} ${id}`);
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter)}`;
}

export function textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/**
 * A whole number within stated bounds.
 *
 * The bounds are the caller's, and they are not decoration: `min` and `max` go on
 * the element for the browser's own validation, and the guard is what keeps a
 * value `parseSettings` would refuse out of this page's memory in the first
 * place. Without it the two disagreed and stayed that way — a password length of
 * 0 reached memory, storage clamped it on the way in, and the page's own storage
 * listener then compared `parseSettings(memory)` against storage, found them
 * equal, and concluded the clamped echo was its own write with nothing to adopt.
 * So the sample on screen was generated from 0 (the empty string) while every
 * fill used the stored length, until the page was reloaded.
 *
 * Anything outside the bounds is ignored rather than clamped as it is typed.
 * Clamping fights the caret — a box on its way to `12` passes through `1` — so
 * the refusal is stated instead of corrected: `aria-invalid` here and
 * `:user-invalid` styling in `options.css` mark the entry, which is the same
 * treatment `optionalNumberInput` gives and for the same reason. Without a
 * visible side the box would show a number the settings will silently ignore.
 */
export function numberInput(
  value: number,
  onChange: (value: number) => void,
  { min, max }: { readonly min: number; readonly max: number },
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener('input', () => {
    // An empty box is on its way somewhere, not wrong: the browser's own
    // constraint validation does not flag it either (the input is optional).
    if (input.value.trim() === '') {
      markValidity(input, true);
      return;
    }
    const parsed = Number(input.value);
    const ok = Number.isInteger(parsed) && parsed >= min && parsed <= max;
    markValidity(input, ok);
    if (ok) onChange(parsed);
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
 * storage, because typing is not the only way a value arrives. A refused value
 * is marked (`aria-invalid`, and `:user-invalid` styling) rather than silently
 * dropped, as in `numberInput`.
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
      markValidity(input, true);
      onChange(undefined);
      return;
    }
    const parsed = Number(input.value);
    const ok = Number.isInteger(parsed) && parsed >= min;
    markValidity(input, ok);
    if (ok) onChange(parsed);
  });
  return input;
}

/** Marks a refused numeric entry, and clears the mark once it is remedied. */
function markValidity(input: HTMLInputElement, ok: boolean): void {
  if (ok) input.removeAttribute('aria-invalid');
  else input.setAttribute('aria-invalid', 'true');
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
  const wrapper = document.createElement('div');
  wrapper.className = 'field check';
  // The box and its text on one line, the hint on the next and outside the
  // label, so it describes the control without becoming part of its name
  // (`field` above does the same and for the same reason).
  const line = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  line.append(box, document.createTextNode(` ${label}`));
  wrapper.append(line);
  if (hint !== undefined) {
    const help = document.createElement('span');
    help.className = 'hint';
    help.textContent = hint;
    help.id = nextId('ff-hint');
    wrapper.append(help);
    describeWith(box, help.id);
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
