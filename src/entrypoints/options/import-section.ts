import { message, type MessageKey } from '@/lib/platform/i18n';
import {
  analyseImport,
  MAX_IMPORT_SIZE,
  oversizeRefusal,
  type ImportDrop,
  type ImportNote,
  type ImportOutcome,
  type ImportPlan,
  type ImportRefusal,
} from '@/lib/settings-import';
import type { OptionsHost } from './host';
import { focusIn } from './controls';
import { problemText } from './problems';
import { reason } from '@/lib/reason';

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
let pending: Pending | undefined;

/**
 * The chosen file, either read or refused for its size before being read.
 *
 * Two shapes rather than one, because A9's refusal is the one that cannot be
 * expressed as text handed to `analyseImport`: the whole point of it is that the
 * text was never produced. A `File` is not kept either — a handle to a file the
 * user may have replaced since is a different thing from the bytes this section
 * analysed, and the size is all the refusal needs to say.
 */
type Pending =
  | { readonly kind: 'read'; readonly name: string; readonly text: string }
  | { readonly kind: 'oversize'; readonly name: string; readonly size: number };

/**
 * The last pick made, for the race the `await` in `chosen` opens — the
 * migrate section's token, on this section's own terms: `pending` is written
 * only after `file.text()` resolves, and the chooser is still mounted during
 * that await, so a second pick races the first and whichever read resolves
 * last wins. A token discards the superseded read; last *pick* wins, the
 * invariant the picker itself promises. Pre-existing here, found with the
 * migrate section's copy.
 */
let pick = 0;

export function renderImport(host: OptionsHost, into: HTMLElement): void {
  const chooser = document.createElement('input');
  chooser.type = 'file';
  chooser.className = 'import-file';
  // A hint to the picker, not a guarantee: a settings file renamed to `.txt` is
  // still a settings file, so every check of its *contents* happens after it is
  // read. Its size is the one thing checked before that, because reading is the
  // part that costs (A9).
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
  const outcome: ImportOutcome =
    pending.kind === 'oversize'
      ? { ok: false, refusal: oversizeRefusal(pending.size) }
      : analyseImport(pending.text, host.settings());
  into.append(
    outcome.ok
      ? planView(host, into, pending.name, outcome.plan)
      : refusalView(host, into, outcome.refusal),
  );
}

async function chosen(host: OptionsHost, into: HTMLElement, file: File | undefined): Promise<void> {
  const token = ++pick;
  if (file === undefined) {
    pending = undefined;
    renderImport(host, into);
    // The chooser that opened the picker was destroyed by the re-render;
    // back on it, where the next attempt starts, rather than `<body>`.
    focusIn(into, '.import-file');
    return;
  }

  // Before `text()`, which is the whole value of the check (A9). Reading a file
  // of arbitrary size into a string on this thread is the damage; a bound
  // applied to the string afterwards would be a report on damage already done.
  // `size` is the browser's own, and costs nothing to ask for.
  if (file.size > MAX_IMPORT_SIZE) {
    pending = { kind: 'oversize', name: file.name, size: file.size };
    renderImport(host, into);
    focusOutcome(into);
    return;
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    // The file was picked and could not be read — removed since, or unreadable.
    // Distinct from a file that read fine and is not ours, which is A1's job.
    if (token !== pick) return; // a later pick superseded this read
    pending = undefined;
    host.announce(message('importUnreadable', [reason(error)]));
    renderImport(host, into);
    focusOutcome(into);
    return;
  }

  // A pick made while this read was in flight has already rendered its own
  // outcome; this stale read writes nothing over it.
  if (token !== pick) return;

  pending = { kind: 'read', name: file.name, text };
  renderImport(host, into);
  focusOutcome(into);
}

/**
 * Puts the focus on the safe action of whatever the choice produced.
 *
 * The migration section's treatment, applied to the surface that had been
 * leaving it on `<body>` since before that section existed: the re-render
 * destroys the focused chooser, the OS picker has just closed, and the
 * focus falls nowhere unless something takes it. Cancel rather than
 * confirm, for the restore confirmation's reason — Enter one keystroke
 * from replacing every setting is the destructive reading of a report the
 * user has only just started reading. And the one outcome with *neither*
 * button — the file that could not be read, announced and gone — lands on
 * the chooser, where the next attempt starts.
 */
function focusOutcome(into: HTMLElement): void {
  if (focusIn(into, '.import-cancel')) return;
  if (focusIn(into, '.import-dismiss')) return;
  focusIn(into, '.import-file');
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
  dismiss.className = 'secondary import-dismiss';
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
  // The file-derived halves of this sentence, carried on the element so
  // `refreshImport` can rebuild it from live settings without re-analysing
  // the file. The incoming side never changes while a file is pending — it
  // *is* the file — and the name is the chooser's own; only the current half
  // is derived from the running settings, so only that half needs a live
  // source. A refresh that re-ran `analyseImport` would be equally correct
  // and costs a file analysis on every keystroke anywhere on the page: A9's
  // bound puts the worst shape at a tenth of a second, which is a real cost
  // for a deliberate action and is not one for a keystroke.
  summary.dataset['incomingRules'] = String(plan.incoming.rules);
  summary.dataset['incomingProfiles'] = String(plan.incoming.profiles);
  summary.dataset['file'] = name;
  view.append(summary);

  if (plan.migrated) {
    const migrated = document.createElement('p');
    migrated.className = 'hint';
    migrated.textContent = message('importPlanMigrated');
    view.append(migrated);
  }

  if (plan.dropped.length > 0) view.append(droppedView(plan.dropped));
  // After the drops, because they are the smaller claim: what is missing
  // afterwards matters before what is present and faulty, and a user who reads
  // only the first list has read the more destructive one.
  if (plan.noted.length > 0) view.append(notedView(plan.noted));

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
  cancel.className = 'secondary import-cancel';
  cancel.textContent = message('importCancel');
  cancel.addEventListener('click', () => {
    discard(host, into, 'importCancelled');
  });

  actions.append(confirm, cancel);
  view.append(actions);
  return view;
}

/**
 * A6 and BR-026-7: every entry named, before the write rather than after it.
 *
 * A drop that carries a `problem` says why in the file's own terms — a rule the
 * parser read and FR-070 will not store — and the fault is resolved here rather
 * than in the analysis, which has no catalog to resolve it against. It is
 * appended to the drop's own substitutions, so the message decides where in the
 * sentence it lands (NFR-018) rather than this concatenating one.
 */
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
    item.textContent = message(
      drop.code,
      drop.problem === undefined ? drop.params : [...drop.params, problemText(drop.problem)],
    );
    list.append(item);
  }

  section.append(heading, list);
  return section;
}

/**
 * BR-026-3's other half: what arrives with a problem, said before the write.
 *
 * A list of its own, next to the drops and never inside them. The two are read
 * as one glance at a heading and a count, and a reader who has to parse each
 * sentence to learn whether the entry survives has been given a worse preview
 * than no list at all. Same shape as `droppedView` because they are read
 * together; different heading, different class, and the fault resolved the same
 * way — `problemText`, appended as a substitution so the catalog decides where
 * in the sentence it lands (NFR-018).
 *
 * Not an `alert`. The plan is on screen because the user just chose a file, and
 * nothing here has happened yet; the exclusion list's own `role="alert"` is
 * where a fault becomes urgent, which is after the import, beside the field that
 * fixes it.
 */
function notedView(noted: readonly ImportNote[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'import-noted';

  const heading = document.createElement('p');
  heading.className = 'import-noted-heading';
  heading.textContent = message('importPlanNoted', [String(noted.length)]);

  const list = document.createElement('ul');
  for (const note of noted) {
    const item = document.createElement('li');
    // As in `droppedView`: every parameter came out of the file, so it is
    // written as text and can never become markup. The fault is appended only
    // where there is one — a note about two entries claiming the same identity
    // has no `RuleProblem` behind it, because the contradiction is between them
    // rather than inside either.
    item.textContent = message(
      note.code,
      note.problem === undefined ? note.params : [...note.params, problemText(note.problem)],
    );
    list.append(item);
  }

  section.append(heading, list);
  return section;
}

/**
 * The summary's "what is there now" half, patched in place after a save
 * (BR-026-5's liveness, the sibling fix to the restore confirmation's).
 *
 * Saving renders nothing — the caret's protection — so a preview opened over
 * one rule count used to keep naming it while a second rule was added
 * elsewhere on the page, and the stale number stayed under the confirm
 * button. The restore confirmation's counts are the sole consent instrument
 * there; these are half of one here, but the same fix applies at a fraction
 * of the cost: the current half is recomputed from live settings, and the
 * incoming half and the file's name are read back off the element the render
 * wrote them on, so no file is re-analysed and nothing but this sentence is
 * touched.
 *
 * A no-op with no plan on screen. Refusals and oversize files carry nothing
 * derived from the running settings, and the chooser is a control the
 * refresh contract says is never rebuilt.
 */
export function refreshImport(host: OptionsHost, into: HTMLElement): void {
  const summary = into.querySelector('.import-summary');
  if (!(summary instanceof HTMLElement)) return;

  const incomingRules = summary.dataset['incomingRules'];
  const incomingProfiles = summary.dataset['incomingProfiles'];
  const file = summary.dataset['file'];
  if (incomingRules === undefined || incomingProfiles === undefined || file === undefined) return;

  const current = host.settings();
  summary.textContent = message('importPlanSummary', [
    String(current.rules.length),
    String(current.profiles.length),
    incomingRules,
    incomingProfiles,
    file,
  ]);
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
