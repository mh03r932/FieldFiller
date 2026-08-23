import { message, type MessageKey } from '@/lib/platform/i18n';
import { analyseImport, type ImportDrop, type ImportPlan, type ImportRefusal } from '@/lib/settings-import';
import type { OptionsHost } from './host';
import { focusIn } from './controls';
import { reason } from './reason';

/**
 * UC-026 — a configuration read back in from a file.
 *
 * Two steps, always, and the separation is the use case rather than a style of
 * dialog: choosing a file produces a *plan*, and only a second, explicit action
 * writes it. An import is the most destructive thing on this page — it replaces
 * every rule, every profile and every setting at once (BR-026-1) — and its
 * damage is invisible until the next fill on a page the user cares about. So
 * what would happen is on screen before it happens (BR-026-5), including every
 * entry the file carries that will not survive (BR-026-3).
 *
 * There is no bypass anywhere below (BR-026-2). A refused file offers no way to
 * proceed, and there is no partial import of the parts that parsed.
 */

/**
 * The file chosen but not yet applied.
 *
 * The *text*, not the plan. This section is re-rendered whenever settings change
 * — including from another tab — and a stored plan would then be showing "what
 * is there now" from whenever the file was chosen. Re-analysing on every render
 * costs nothing and cannot go stale, which matters because that half of the
 * comparison is the one BR-026-5 exists for.
 *
 * Module scope, like the rule editor's open item, so it survives a re-render.
 */
let pending: { readonly name: string; readonly text: string } | undefined;

export function renderImport(host: OptionsHost, into: HTMLElement): void {
  const chooser = document.createElement('input');
  chooser.type = 'file';
  chooser.className = 'import-file';
  // A hint to the picker, not a guarantee: a settings file renamed to `.txt` is
  // still a settings file, and every real check happens after it is read.
  chooser.accept = 'application/json,.json';
  chooser.addEventListener('change', () => {
    void chosen(host, into, chooser.files?.[0]);
  });

  const label = document.createElement('label');
  label.className = 'field';
  const labelText = document.createElement('span');
  labelText.textContent = message('importFileLabel');
  label.append(labelText, chooser);

  into.replaceChildren(label);

  if (pending === undefined) return;
  const outcome = analyseImport(pending.text, host.settings());
  into.append(
    outcome.ok
      ? planView(host, into, pending.name, outcome.plan)
      : refusalView(host, into, outcome.refusal),
  );
}

async function chosen(host: OptionsHost, into: HTMLElement, file: File | undefined): Promise<void> {
  if (file === undefined) {
    pending = undefined;
    renderImport(host, into);
    return;
  }

  try {
    pending = { name: file.name, text: await file.text() };
  } catch (error) {
    // The file was picked and could not be read — removed since, or unreadable.
    // Distinct from a file that read fine and is not ours, which is A1's job.
    pending = undefined;
    host.announce(message('importUnreadable', [reason(error)]));
  }
  renderImport(host, into);
}

/**
 * A1, A2, A5 — stated, with no way past it (BR-026-2).
 *
 * The dismiss button is not a way past it. It imports nothing and offers
 * nothing: it puts the file down, which is the one thing the user could not do
 * before — a refused file is re-analysed on every render, so a redraw from
 * another tab's write brought the refusal back with no way to make it go away
 * short of reloading the page. Choosing another file has always worked, and
 * still does; this is for the user who has finished with this one.
 *
 * A fragment rather than a wrapper element, so the alert is inserted into the
 * section itself exactly as it was before the button existed. An alert is
 * announced on being added to the DOM, and burying it a level deeper is not a
 * change worth making for a layout that does not need it.
 */
function refusalView(
  host: OptionsHost,
  into: HTMLElement,
  refusal: ImportRefusal,
): DocumentFragment {
  const paragraph = document.createElement('p');
  paragraph.className = 'problem import-refused';
  paragraph.setAttribute('role', 'alert');
  paragraph.textContent = message(refusal.code, refusal.params);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'import-dismiss';
  dismiss.textContent = message('importDismiss');
  dismiss.addEventListener('click', () => {
    discard(host, into, 'importDismissed');
  });

  const view = document.createDocumentFragment();
  view.append(paragraph, dismiss);
  return view;
}

/**
 * Puts the chosen file down without importing it.
 *
 * One function for the plan's cancel and the refusal's dismiss, because it is
 * one act: forget the file, redraw, say so, and put the focus back where a
 * second attempt starts. Only the wording differs, and it has to — a cancelled
 * import is one that could have happened, a dismissed refusal is one that never
 * could, and telling the second user their import was "cancelled" would credit
 * them with a decision the extension made for them.
 */
function discard(host: OptionsHost, into: HTMLElement, announcement: MessageKey): void {
  pending = undefined;
  renderImport(host, into);
  host.announce(message(announcement));
  focusIn(into, '.import-file');
}

/**
 * Step 5: what the import will do, before it does it.
 *
 * Both sides in one sentence (BR-026-5) — what is stored now and what the file
 * brings — because the number that matters to someone about to replace their
 * configuration is the one they are about to lose.
 */
function planView(host: OptionsHost, into: HTMLElement, name: string, plan: ImportPlan): HTMLElement {
  const view = document.createElement('div');
  view.className = 'import-plan';

  const summary = document.createElement('p');
  summary.className = 'import-summary';
  // `textContent`, and the file's name is the user's own text.
  summary.textContent = message('importPlanSummary', [
    String(plan.current.rules),
    String(plan.current.profiles),
    String(plan.incoming.rules),
    String(plan.incoming.profiles),
    name,
  ]);
  view.append(summary);

  if (plan.migrated) {
    const migrated = document.createElement('p');
    migrated.className = 'hint';
    migrated.textContent = message('importPlanMigrated');
    view.append(migrated);
  }

  if (plan.dropped.length > 0) view.append(droppedView(plan.dropped));

  const actions = document.createElement('div');
  actions.className = 'import-actions';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary import-confirm';
  confirm.textContent = message('importConfirm');
  confirm.addEventListener('click', () => {
    void apply(host, into, name, plan);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'import-cancel';
  cancel.textContent = message('importCancel');
  cancel.addEventListener('click', () => {
    discard(host, into, 'importCancelled');
  });

  actions.append(confirm, cancel);
  view.append(actions);
  return view;
}

/** A6 and BR-026-7: every entry named, before the write rather than after it. */
function droppedView(dropped: readonly ImportDrop[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'import-dropped';

  const heading = document.createElement('p');
  heading.className = 'import-dropped-heading';
  heading.textContent = message('importPlanDropped', [String(dropped.length)]);

  const list = document.createElement('ul');
  for (const drop of dropped) {
    const item = document.createElement('li');
    // Every parameter here came out of the file, so it is written as text and
    // can never become markup — a rule labelled `<img onerror=…>` is a label.
    item.textContent = message(drop.code, drop.params);
    list.append(item);
  }

  section.append(heading, list);
  return section;
}

/**
 * Step 7: one write, or none (BR-026-6).
 *
 * `host.replace` settles when storage has, so what is announced here is what
 * landed rather than what was attempted — which is the whole of A7. On a
 * rejected write the page has already said so, the plan stays on screen, and the
 * previous configuration is still in force because nothing partial was ever
 * written.
 */
async function apply(host: OptionsHost, into: HTMLElement, name: string, plan: ImportPlan): Promise<void> {
  try {
    await host.replace(plan.settings);
  } catch {
    // Announced by `replace` itself, in the same words every other rejected
    // write on this page uses. Saying it twice here would be the page arguing
    // with itself about whose failure it was.
    return;
  }

  // Only now. Clearing the file first would leave a failed import with nothing
  // on screen to retry from, and the plan is exactly what the user would need.
  pending = undefined;
  host.redraw();
  host.announce(
    message('importDone', [String(plan.incoming.rules), String(plan.incoming.profiles), name]),
  );
  // The redraw destroyed the button that was focused, so the focus is put
  // somewhere real rather than left on `<body>` — back at the chooser, which is
  // where a second import would start.
  focusIn(into, '.import-file');
}
