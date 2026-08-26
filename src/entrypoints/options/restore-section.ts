import { message } from '@/lib/platform/i18n';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { isDefaultConfiguration, restoreLoss } from '@/lib/restore';
import type { OptionsHost } from './host';
import { focusIn } from './controls';

/**
 * UC-028 — the shipped defaults, back over everything above.
 *
 * Its own module for the same reason the export and import sections are theirs:
 * this is not the shape a settings section is. Nothing here edits a slice of
 * state or keeps a control in sync; the whole behaviour is one replacement
 * behind a confirmation, which is the import's shape with the file's source
 * swapped for the running build's own defaults.
 *
 * **The confirmation is counts, re-computed on every render and every save.**
 * The numbers name what will be discarded (BR-028-2), and they are read from
 * `host.settings()` rather than captured when the button was clicked. Three
 * writers can move them while the confirmation is open, and until review
 * caught it only two had a trigger: a change from another tab is adopted by
 * the storage listener (rendering the section, or calling `refreshRestore`
 * for the focus-skip below), a whole-configuration write redraws everything —
 * and an edit made on *this* page saved per change and rendered nothing,
 * because a rebuild takes the caret. So a third rule added while the
 * confirmation read two was discarded as two, and a defaults-only page could
 * say "this changes nothing" over a password length it was about to discard
 * — the screen asserting the opposite of the write. `host.save` now runs
 * every section's refresh after each write to memory, and `refreshRestore`
 * is the same patch-in-place for all three triggers: the two computed lines
 * rewritten, no control rebuilt, the focus the skip exists to protect left
 * exactly where it was.
 *
 * "Every render" includes the one the page almost does not make: the adoption
 * render skips a section that holds the focus, and opening the confirmation
 * deliberately focuses its cancel button — so the foreign change named above
 * is the one change a rebuild would never see. `refreshRestore` below is what
 * the page calls on that skip instead, rewriting the two computed lines in
 * place and touching no control. Nothing is staged and nothing is held:
 * cancelling leaves no state anywhere (A1), which is why the only thing this
 * module remembers is that the confirmation is open at all.
 *
 * **No undo, by design rather than by omission (BR-028-5).** The way back is
 * export, named in the confirmation itself before the write — the settings
 * store holds one state (BR-024-1), so a second copy held on a timer for an
 * undo window would be a state no validation ever saw, and the page's next
 * write would have to remember to supersede it.
 */

/** Whether the confirmation is open. Module scope, like the import's pending file. */
let confirming = false;

export function renderRestore(host: OptionsHost, into: HTMLElement): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'restore-button';
  button.textContent = message('restoreButton');
  button.addEventListener('click', () => {
    confirming = true;
    renderRestore(host, into);
    // The re-render above destroyed the focused button, and the focus has to
    // land somewhere real — this page's rule, everywhere else it removes a
    // control, is that a keyboard user must not be returned to the top of the
    // page for the act of opening something. Onto the cancel rather than the
    // entry button: restoring focus to where the click happened would leave
    // Enter one keystroke from committing the destructive write, over a
    // confirmation the user has only just started to read. Cancel is the safe
    // action, and Tab reaches confirm from it in one move.
    focusIn(into, '.restore-cancel');
  });

  into.replaceChildren(button);
  if (!confirming) return;
  into.append(planView(host, into));
}

/**
 * Steps 2 and 3: what restoring means, in counts, and the way back — both before
 * anything is written.
 *
 * The two standing sentences (what resets, and that there is no undo) are drawn
 * every time, because they are true every time; the counts and A2's
 * "already the shipped ones" line are computed, because they describe a state
 * that can change while the confirmation is open. Both computed lines are
 * built by their own functions, because `refreshRestore` rewrites them
 * without the rest of this view.
 */
function planView(host: OptionsHost, into: HTMLElement): HTMLElement {
  const settings = host.settings();

  const view = document.createElement('div');
  view.className = 'restore-plan';

  view.append(summaryLine(settings));
  const already = alreadyLine(settings);
  if (already !== undefined) view.append(already);

  // BR-028-5, after the counts so it reads as their consequence: nothing comes
  // back, so the copy you might want is the one you make now.
  const noUndo = document.createElement('p');
  noUndo.className = 'hint restore-no-undo';
  noUndo.textContent = message('restorePlanNoUndo');
  view.append(noUndo);

  const actions = document.createElement('div');
  actions.className = 'restore-actions';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary restore-confirm';
  confirm.textContent = message('restoreConfirm');
  confirm.addEventListener('click', () => {
    void apply(host, into);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'restore-cancel';
  cancel.textContent = message('restoreCancel');
  cancel.addEventListener('click', () => {
    // A1: nothing was written and nothing is held — closing the confirmation is
    // the whole of the cancellation, and the announcement says the settings are
    // unchanged rather than merely that a dialogue went away.
    confirming = false;
    renderRestore(host, into);
    host.announce(message('restoreCancelled'));
    focusIn(into, '.restore-button');
  });

  actions.append(confirm, cancel);
  view.append(actions);
  return view;
}

/** The counts sentence, the confirmation's first and load-bearing line (BR-028-2). */
function summaryLine(settings: Settings): HTMLElement {
  const loss = restoreLoss(settings);

  const summary = document.createElement('p');
  summary.className = 'restore-summary';
  summary.textContent = message('restorePlanCounts', [
    String(loss.rules),
    String(loss.profiles),
    String(loss.fieldExclusions),
    String(loss.domainExclusions),
  ]);
  return summary;
}

/**
 * A2's line, when the state has earned it: said in the confirmation, and the
 * restore stays offered — a defaults-only configuration is the state the
 * extension ships in, not an error, and "prove this installation is clean" is
 * a legitimate want.
 */
function alreadyLine(settings: Settings): HTMLElement | undefined {
  if (!isDefaultConfiguration(settings)) return undefined;

  const already = document.createElement('p');
  already.className = 'hint restore-already';
  already.textContent = message('restorePlanAlready');
  return already;
}

/**
 * The confirmation's two computed lines, rewritten in place — the render the
 * page owes a section that holds the focus, paid without rebuilding it.
 *
 * Two callers, one contract. The adoption render skips whatever holds the
 * focus, and opening the confirmation deliberately focuses its cancel button,
 * so a foreign write arriving while the confirmation is open is the one
 * change a rebuild would never see — the page calls this on exactly that
 * skip. And `host.save` calls it after every write to memory, because a save
 * renders nothing and an edit made anywhere on this page can move the counts
 * the same way a foreign write can: the summary and the already-defaults
 * line are replaced and nothing else is touched, which is the whole
 * difference between this and a render. The buttons — and the focus inside
 * them — survive, so the skip's purpose is kept without paying its cost in
 * stale counts.
 *
 * A no-op with the confirmation closed: the only thing on screen then is the
 * entry button, whose label was never about the settings.
 */
export function refreshRestore(host: OptionsHost, into: HTMLElement): void {
  const plan = into.querySelector('.restore-plan');
  if (plan === null) return;

  const settings = host.settings();
  plan.querySelector('.restore-summary')?.replaceWith(summaryLine(settings));

  const already = plan.querySelector('.restore-already');
  const line = alreadyLine(settings);
  if (line === undefined) {
    already?.remove();
  } else if (already === null) {
    plan.querySelector('.restore-summary')?.after(line);
  } else {
    already.replaceWith(line);
  }
}

/**
 * Step 5: the shipped defaults, as one replacement.
 *
 * `host.replace` is the import's write, and it is load-bearing here for both of
 * its properties: it settles when storage has, so A3 can say the restore did
 * not happen rather than guess, and it rolls the page's memory back on a
 * rejected write — without which every section would go on computing its next
 * save from defaults storage never accepted, and the first checkbox ticked
 * anywhere would commit the restore the user was told had failed.
 *
 * On failure the confirmation stays on screen, for the import's reason: it is
 * exactly what a retry needs, and the page has already said why the write was
 * refused, in the same words every other rejected write uses.
 */
async function apply(host: OptionsHost, into: HTMLElement): Promise<void> {
  try {
    await host.replace(DEFAULT_SETTINGS);
  } catch {
    return;
  }

  // Only now, and only the flag: the counts were computed, never stored, so
  // there is nothing else to clear.
  confirming = false;
  host.redraw();
  host.announce(message('restoreDone'));
  // The redraw destroyed the focused button; back to the entry point, where a
  // second restore would start.
  focusIn(into, '.restore-button');
}
