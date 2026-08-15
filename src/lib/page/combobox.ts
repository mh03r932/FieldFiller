import type { Scheduler } from './settle';

/**
 * Driving a control that behaves as a select without being one (FR-081,
 * UC-034 A9/A10, BR-034-9).
 *
 * Every design system reimplements the select, and none of them reimplements it
 * as a `<select>`. The result is a `div` with `role="combobox"` and a popup that
 * is rendered somewhere else in the document entirely — which is why nothing in
 * the native walk finds it, and why finding it is not enough.
 *
 * **The rule that shapes this whole file: a custom control is driven the way a
 * user drives it, or not at all.** There is almost always an
 * `<input type="hidden">` behind such a component carrying what the form will
 * submit, and writing it directly is one line and always "works". It also
 * updates what gets submitted without updating what the component believes, so
 * the page reads "Select…" while the submission carries "GB" — wrong, and
 * invisible, which is worse than an unfilled field. It is excluded by type in
 * the walk for exactly this reason, and nothing here goes looking for it.
 *
 * The ladder is keyboard, then pointer, then put everything back. Each rung is
 * verified before it is believed, and the whole thing is bounded: opening a
 * popup and walking away leaves the user in a focus trap, so the restore rung is
 * not optional and not best-effort.
 */

/** What the agent needs from the page to drive one control, injected for testing. */
export type ComboboxResult =
  | { readonly driven: true; readonly rung: 'keyboard' | 'pointer' }
  | { readonly driven: false; readonly reason: string };

export type ComboboxOptions = {
  /** Position in the offered list, in [0, 1). Comes from the background (FR-081). */
  readonly at: number;
  readonly scheduler: Scheduler;
  /** How long one control may take before it is abandoned and restored. */
  readonly budgetMs: number;
};

/**
 * How long to let the page respond to each interaction before looking.
 *
 * A component opens its popup on the next render, not synchronously, so reading
 * immediately finds nothing at all. Small because this is paid per rung per
 * control: on a page of sixty comboboxes the total is what threatens NFR-001,
 * which is why `budgetMs` exists above it.
 */
const REACTION_MS = 30;

/** The popup an open combobox owns, wherever the page decided to render it. */
function popupFor(control: Element): Element | undefined {
  // A detached control's root is a bare `DocumentFragment`, which has no
  // `getElementById`. Typed as optional rather than asserted, because asserting
  // it would turn "this control is no longer in the page" into a TypeError
  // inside a `finally`.
  const root = control.getRootNode() as Node & {
    getElementById?: (id: string) => Element | null;
  };

  // The authoring pattern's own answer, and the only one that works when the
  // popup is portaled to `document.body` — as it is in MUI, Ant, Radix and every
  // other library that has to escape an `overflow: hidden` ancestor.
  for (const attribute of ['aria-controls', 'aria-owns']) {
    const id = control.getAttribute(attribute);
    if (id === null) continue;
    for (const part of id.split(/\s+/)) {
      const found = root.getElementById?.(part);
      if (found !== undefined && found !== null && hasOptions(found)) return found;
    }
  }

  // The control *is* the listbox — the inline pattern, where there is no popup
  // and the options are children.
  if (hasOptions(control)) return control;

  // A popup rendered as a sibling or descendant without declaring the
  // relationship. Deliberately not a document-wide search for any open listbox:
  // with two comboboxes on a page that finds the wrong one, and picking an
  // answer in the wrong control is worse than not picking one.
  const nearby = control.parentElement?.querySelector('[role="listbox"], [role="menu"]');
  return nearby !== null && nearby !== undefined && hasOptions(nearby) ? nearby : undefined;
}

function hasOptions(container: Element): boolean {
  return container.querySelector('[role="option"]') !== null;
}

function optionsOf(popup: Element): HTMLElement[] {
  return [...popup.querySelectorAll<HTMLElement>('[role="option"]')].filter(
    (option) =>
      option.getAttribute('aria-disabled') !== 'true' && !option.hasAttribute('disabled'),
  );
}

/** The text a user reads on the control itself, never on the popup. */
function displayed(control: Element): string {
  // `textContent` reads non-nullable in lib.dom — the `| null` belongs to the
  // setter — so there is nothing to guard against here.
  return control.textContent.replace(/\s+/g, ' ').trim();
}

const delay = (scheduler: Scheduler, ms: number): Promise<void> =>
  new Promise((resolve) => {
    scheduler.setTimeout(resolve, ms);
  });

function key(target: Element, name: string): void {
  for (const type of ['keydown', 'keyup']) {
    target.dispatchEvent(
      new KeyboardEvent(type, { key: name, code: name, bubbles: true, cancelable: true }),
    );
  }
}

/**
 * Clicks the way a component listens for a click.
 *
 * `pointerdown`, `mousedown`, `mouseup`, `click`, in that order. Not
 * `element.click()` alone: an option list almost always commits on `mousedown`
 * and calls `preventDefault()` there to stop the trigger losing focus, so a bare
 * `click()` misses the handler the component actually installed.
 */
function press(target: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

/**
 * Opens a control, chooses from what it then offers, and verifies the answer.
 *
 * Returns without having changed focus or scroll, whatever the outcome. A page
 * left holding an open popup, a focus trap or a scroll lock because we walked
 * away mid-interaction is a worse result than an unfilled field (BR-034-10).
 */
export async function driveCombobox(
  control: Element,
  options: ComboboxOptions,
): Promise<ComboboxResult> {
  if (!(control instanceof HTMLElement)) return { driven: false, reason: 'not-an-element' };

  const { scheduler } = options;
  const deadline = scheduler.now() + options.budgetMs;

  // Recorded before anything is touched, so the restore below has something to
  // restore *to*. The focused element is page state we put back, not page
  // content we read — nothing here is retained past this function.
  const focused = control.ownerDocument.activeElement;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // The one piece of page text this function holds, for as long as one control
  // takes. It is compared against and dropped; it is never stored, sent or
  // reported (BR-034-11). Without it there is no way to answer "did the control
  // change" — a custom combobox has no `value` to read back.
  const before = displayed(control);

  try {
    const byKeyboard = await attempt(control, options, deadline, before, 'keyboard');
    if (byKeyboard.driven) return byKeyboard;

    // The first rung may have left the popup open with nothing chosen.
    await close(control, options);

    const byPointer = await attempt(control, options, deadline, before, 'pointer');
    if (byPointer.driven) return byPointer;

    return { driven: false, reason: byPointer.reason };
  } catch (error) {
    return { driven: false, reason: String(error) };
  } finally {
    // Unconditional, and the reason the whole ladder is wrapped: an exception
    // from a page's own handler must not be able to leave a popup open.
    //
    // `close` dispatches into the page, so it can throw for the same reason
    // anything else here can — and a throw *inside a `finally`* replaces the
    // outcome and skips everything after it, which would lose the focus and
    // scroll restore. That is the failure this block exists to prevent, so it
    // gets its own guard.
    //
    // A browser does not propagate an exception from a listener back to
    // `dispatchEvent` at all — it goes to `window.onerror` — so in production
    // this catch is unreachable through that path. The test DOM does propagate
    // it, and it is the stricter of the two assumptions, so this is written for
    // the stricter one.
    try {
      await close(control, options);
    } catch {
      // Nothing useful to do. The restore below is what matters.
    }
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    else control.blur();
    window.scrollTo(scrollX, scrollY);
  }
}

async function attempt(
  control: HTMLElement,
  options: ComboboxOptions,
  deadline: number,
  before: string,
  rung: 'keyboard' | 'pointer',
): Promise<ComboboxResult> {
  const { scheduler } = options;
  if (scheduler.now() >= deadline) return { driven: false, reason: 'combobox-budget-spent' };

  control.focus();
  if (rung === 'keyboard') key(control, 'ArrowDown');
  else press(control);

  await delay(scheduler, REACTION_MS);

  const popup = popupFor(control);
  if (popup === undefined) return { driven: false, reason: 'combobox-offered-nothing' };

  const offered = optionsOf(popup);
  if (offered.length === 0) return { driven: false, reason: 'combobox-offered-nothing' };

  // The background chose a position; the agent maps it onto a length only the
  // agent can see. Clamped rather than modulo'd, so a value at the very top of
  // the range cannot wrap round to the first option.
  const index = Math.min(offered.length - 1, Math.floor(options.at * offered.length));
  const chosen = offered[index]!;
  // Read here and compared below, within this interaction. The label is the only
  // thing that makes the check strong rather than "something changed", and it
  // goes no further than this function.
  const label = chosen.textContent.replace(/\s+/g, ' ').trim();

  if (rung === 'keyboard') {
    // Arrowing from the first option rather than jumping: a roving-tabindex
    // listbox has no way to be told "go to index 4", and `aria-activedescendant`
    // is the component's state to set, not ours.
    for (let step = 0; step < index; step++) key(control, 'ArrowDown');
    key(control, 'Enter');
  } else {
    press(chosen);
  }

  await delay(scheduler, REACTION_MS);

  return verify(control, before, label)
    ? { driven: true, rung }
    : { driven: false, reason: 'combobox-answer-did-not-take' };
}

/**
 * Whether the control now shows the answer that was chosen (BR-034-9).
 *
 * Checked on the control the user looks at, never on the hidden field behind it.
 * A component that updates its payload without updating its display has not been
 * filled, however good the submission would look.
 *
 * Three ways to be sure, because component libraries disagree about which they
 * maintain after closing: the control renders the chosen option's text; or it
 * points at an option through `aria-activedescendant`; or an option it owns is
 * marked selected. The first is the one a user would use.
 */
function verify(control: HTMLElement, before: string, label: string): boolean {
  const now = displayed(control);
  if (now !== '' && now !== before && label !== '' && now.toLowerCase().includes(label.toLowerCase())) {
    return true;
  }

  const active = control.getAttribute('aria-activedescendant');
  if (active !== null && active !== '') return true;

  const popup = popupFor(control);
  if (popup !== undefined && popup.querySelector('[role="option"][aria-selected="true"]') !== null) {
    return true;
  }

  return false;
}

/**
 * The weaker check the end of the fill can afford, and an honest account of why
 * it is weaker.
 *
 * The check made at the moment of driving compares the control's rendered text
 * against the chosen option's label, which is strong. Repeating it when the fill
 * ends would mean carrying that label — page content — from the interaction to
 * the end of the fill, and BR-034-11 is unconditional: nothing read back is
 * stored. So this asks the two questions that need nothing remembered.
 *
 * **What it catches:** a popup still open, which is the failure that traps the
 * user; and a control the page emptied completely.
 *
 * **What it misses:** a page that resets the control to its placeholder. "Select
 * a country" and "United Kingdom" are both non-empty text in a `<span>`, and
 * without the label there is nothing to tell them apart. Such a combobox is
 * reported filled when it is not — a real gap, recorded here rather than left
 * for someone to find. Closing it means either retaining the label, which the
 * privacy rule forbids, or a signal the ARIA pattern does not require components
 * to maintain once closed.
 */
export function stillAnswered(control: Element): { landed: boolean; reason: string } {
  if (control.getAttribute('aria-expanded') === 'true') {
    return { landed: false, reason: 'combobox-left-open' };
  }
  return displayed(control) === ''
    ? { landed: false, reason: 'combobox-answer-did-not-survive' }
    : { landed: true, reason: '' };
}

/** Puts a popup away. Sent to both, because either may own the dismissal. */
async function close(control: HTMLElement, options: ComboboxOptions): Promise<void> {
  if (control.getAttribute('aria-expanded') !== 'true' && popupFor(control) === undefined) return;
  key(control, 'Escape');
  await delay(options.scheduler, REACTION_MS);
}
