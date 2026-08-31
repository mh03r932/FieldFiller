import { message, type MessageKey } from '@/lib/platform/i18n';
import {
  analyseMigration,
  type MigrationDrop,
  type MigrationNote,
  type MigrationOutcome,
  type MigrationPlan,
  type MigrationRefusal,
} from '@/lib/fakefiller-migrate';
import { MAX_IMPORT_SIZE, oversizeRefusal } from '@/lib/settings-import';
import type { OptionsHost } from './host';
import { focusIn } from './controls';
import { problemText } from './problems';
import { reason } from '@/lib/reason';

/**
 * UC-027 — a Fake Filler backup, translated and written, on screen.
 *
 * The import section's shape with the file's source swapped, because the
 * two make the same promise and differ only in where the file came from:
 * choosing a file produces a *plan* and nothing is written until a second,
 * explicit action agrees to it (steps 5 and 6). The plan is what is on
 * screen before the write — both sides, everything that will not arrive,
 * and everything that arrives different — because a migration replaces
 * every rule, every profile and every setting at once (BR-027-1), and its
 * damage is invisible until the next fill on a page the user cares about.
 *
 * **Its own control, beside import rather than shared with it (step 1).**
 * The two buttons make different promises — "read back what this
 * extension wrote" and "translate what another product wrote" — and a
 * shared chooser would have to ask which was meant only after the file
 * was already open, which is the answer that should have decided the
 * question. Recognition can usually tell (each refusal points at the
 * other section), but starting the user in the right one is cheaper than
 * correcting them, and a migrant who has never seen this extension's
 * options page before is starting from the word "Fake Filler", which is
 * on exactly one of the two headings.
 *
 * No bypass anywhere (ND-13): a refused file offers no way to proceed,
 * and the dismiss button only puts it down.
 */

/**
 * The file chosen but not yet applied.
 *
 * The *text*, not the plan, for the import section's reason: this section
 * re-renders whenever settings change — including from another tab — and a
 * stored plan would be showing "what is there now" from whenever the file
 * was chosen. Re-analysing on every render cannot go stale, which is the
 * half of the comparison BR-026-5 exists for.
 *
 * Module scope, like the import's pending file, so it survives a render.
 */
let pending: Pending | undefined;

/**
 * The chosen file, either read or refused for its size before being read.
 *
 * The size refusal exists as its own shape because it is the one refusal
 * that cannot be expressed as text handed to `analyseMigration`: the whole
 * point is that the text was never produced (A8).
 */
type Pending =
  | { readonly kind: 'read'; readonly name: string; readonly text: string }
  | { readonly kind: 'oversize'; readonly name: string; readonly size: number };

/**
 * The last pick made, for the race the `await` in `chosen` opens.
 *
 * `pending` is written only after `file.text()` resolves, and the chooser is
 * still mounted during that await — so a second pick starts a second `chosen`
 * and whichever read resolves *last* wins `pending` and the final render: a
 * large first file can overwrite a later, smaller pick. Element identity
 * cannot guard this (both picks land on the same still-mounted input), so a
 * token does: every pick increments, and a read whose token has been
 * superseded is discarded on resolution. Last *pick* wins, whatever the
 * reads' completion order — the invariant the picker itself promises.
 */
let pick = 0;

export function renderMigrate(host: OptionsHost, into: HTMLElement): void {
  const chooser = document.createElement('input');
  chooser.type = 'file';
  chooser.className = 'migrate-file';
  // A hint to the picker, not a guarantee. The reference's exports
  // download as `.txt` files containing Base64, and a backup renamed to
  // `.json` is still a backup, so everything about the *contents* is
  // decided after the read. Its size is the one thing checked before
  // that, because reading is the part that costs (A8).
  chooser.accept = '.txt,application/json,.json,text/plain';
  chooser.addEventListener('change', () => {
    void chosen(host, into, chooser.files?.[0]);
  });

  const label = document.createElement('label');
  label.className = 'field';
  const labelText = document.createElement('span');
  labelText.textContent = message('migrateFileLabel');
  label.append(labelText, chooser);

  into.replaceChildren(label);

  if (pending === undefined) return;
  const outcome: MigrationOutcome =
    pending.kind === 'oversize'
      ? { ok: false, refusal: { ...oversizeRefusal(pending.size), code: 'migrateRefusedTooLarge' } }
      : analyseMigration(pending.text, host.settings());
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
    renderMigrate(host, into);
    // The chooser that opened the picker was destroyed by the re-render, so
    // the focus would otherwise fall to `<body>` — this page's rule, wherever
    // else it removes a control, is that a keyboard user is put somewhere
    // real. Back on the chooser, where the next attempt starts.
    focusIn(into, '.migrate-file');
    return;
  }

  // Before `text()`, for the import section's reason and A8's: reading a
  // file of arbitrary size into a string on this thread is the damage, and
  // a bound applied to the string afterwards is a report on damage
  // already done.
  if (file.size > MAX_IMPORT_SIZE) {
    pending = { kind: 'oversize', name: file.name, size: file.size };
    renderMigrate(host, into);
    focusOutcome(into);
    return;
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    if (token !== pick) return; // a later pick superseded this read
    pending = undefined;
    host.announce(message('migrateUnreadable', [reason(error)]));
    renderMigrate(host, into);
    focusOutcome(into);
    return;
  }

  // The race guard's whole duty: a pick made while this read was in flight
  // has already rendered its own outcome, and this stale read writes
  // nothing over it.
  if (token !== pick) return;

  pending = { kind: 'read', name: file.name, text };
  renderMigrate(host, into);
  focusOutcome(into);
}

/**
 * Puts the focus on the safe action of whatever the choice produced.
 *
 * The re-render above destroyed the focused chooser, and the user's last
 * gesture closed an OS dialogue — nothing is holding the focus, so it falls
 * to `<body>` unless something takes it. Cancel rather than confirm, for the
 * restore confirmation's reason: the user has only just started reading the
 * report, and Enter one keystroke from committing a whole-configuration
 * replacement is the destructive reading. A refusal's only action is its
 * dismiss, which is safe by construction. And the one outcome with *neither*
 * button — the file that could not be read, announced and gone — lands on
 * the chooser, which is where the next attempt starts; it used to fall to
 * `<body>`, the exact gap the focus work in this change set out to close.
 */
function focusOutcome(into: HTMLElement): void {
  if (focusIn(into, '.migrate-cancel')) return;
  if (focusIn(into, '.migrate-dismiss')) return;
  focusIn(into, '.migrate-file');
}

/**
 * A1's refusals — stated, with no way past them.
 *
 * The dismiss button is not a way past it; it puts the file down, which is
 * the one thing the user could not do before. `migrateRefusedOurs` is the
 * one refusal that names a better destination rather than a fault, and its
 * wording does the pointing (A1 step 2).
 */
function refusalView(
  host: OptionsHost,
  into: HTMLElement,
  refusal: MigrationRefusal,
): DocumentFragment {
  const paragraph = document.createElement('p');
  paragraph.className = 'problem migrate-refused';
  paragraph.setAttribute('role', 'alert');
  paragraph.textContent = message(refusal.code, refusal.params);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'secondary migrate-dismiss';
  dismiss.textContent = message('migrateDismiss');
  dismiss.addEventListener('click', () => {
    discard(host, into, 'migrateDismissed');
  });

  const view = document.createDocumentFragment();
  view.append(paragraph, dismiss);
  return view;
}

/**
 * Puts the chosen file down without migrating.
 *
 * One function for the plan's cancel and the refusal's dismiss, because it
 * is one act — forget the file, redraw, say so — and only the wording
 * differs, for the import section's reason: a cancelled migration is one
 * that could have happened, a dismissed refusal is one that never could.
 */
function discard(host: OptionsHost, into: HTMLElement, announcement: MessageKey): void {
  pending = undefined;
  renderMigrate(host, into);
  host.announce(message(announcement));
  focusIn(into, '.migrate-file');
}

/**
 * Step 5: the whole report, before the write.
 *
 * Ordered by how destructive each line is, top to bottom: the summary
 * (what is replaced by what), the version preamble (A2 — what the
 * translation was written against, when it matters), the persona sentence
 * (BR-027-6 — the one deliberate behaviour change), then the two lists —
 * drops first, because "gone" is the more serious claim of the two and a
 * user who reads only the first list has read the more destructive one.
 */
function planView(
  host: OptionsHost,
  into: HTMLElement,
  name: string,
  plan: MigrationPlan,
): HTMLElement {
  const view = document.createElement('div');
  view.className = 'import-plan migrate-plan';

  const summary = document.createElement('p');
  summary.className = 'import-summary migrate-summary';
  summary.textContent = message('migratePlanSummary', [
    String(plan.current.rules),
    String(plan.current.profiles),
    String(plan.incoming.rules),
    String(plan.incoming.profiles),
    name,
  ]);
  // The file-derived halves of this sentence, carried on the element so
  // `refreshMigrate` can rebuild it from live settings without re-translating
  // the backup. The incoming side never changes while a file is pending — it
  // *is* the file — and the name is the chooser's own; only the "now" half is
  // derived from the running settings. Same arrangement as the import preview
  // beside this, for the same reason: a refresh that re-ran `analyseMigration`
  // would be equally correct and costs a translation on every save anywhere on
  // the page, which is not a cost the caret's protection was built to add.
  summary.dataset['incomingRules'] = String(plan.incoming.rules);
  summary.dataset['incomingProfiles'] = String(plan.incoming.profiles);
  summary.dataset['file'] = name;
  view.append(summary);

  // A2, and it leads: everything below it is the translation's output, and
  // the preamble is the one line about the translation's *premise*. Said
  // whether the version is wrong or absent — an undocumented version is
  // the same doubt with a blank where the number was.
  if (!plan.versionStated || plan.sourceVersion !== 1) {
    const version = document.createElement('p');
    version.className = 'hint migrate-version';
    version.textContent = plan.versionStated
      ? message('migratePlanVersion', [String(plan.sourceVersion)])
      : message('migratePlanVersionAbsent');
    view.append(version);
  }

  // BR-027-6, once, rather than named on every persona-backed rule: it is
  // the direction this product defines as correct, and a sentence per rule
  // would bury the losses beneath a change none of them asked about.
  if (plan.personaBacked) {
    const persona = document.createElement('p');
    persona.className = 'hint migrate-persona';
    persona.textContent = message('migratePlanPersona');
    view.append(persona);
  }

  if (plan.dropped.length > 0) view.append(droppedView(plan.dropped));
  if (plan.noted.length > 0) view.append(notedView(plan.noted));

  const actions = document.createElement('div');
  actions.className = 'import-actions migrate-actions';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary migrate-confirm';
  confirm.textContent = message('migrateConfirm');
  confirm.addEventListener('click', () => {
    void apply(host, into, name, plan);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary migrate-cancel';
  cancel.textContent = message('migrateCancel');
  cancel.addEventListener('click', () => {
    discard(host, into, 'migrateCancelled');
  });

  actions.append(confirm, cancel);
  view.append(actions);
  return view;
}

/**
 * Everything that will not arrive, each entry named with its reason
 * (step 5, FR-056).
 *
 * A drop carrying a `problem` says why in the editor's own words (A4
 * step 1), resolved by the same helper the import's drop list uses, and
 * appended as a substitution so the catalog decides where in the sentence
 * it lands (NFR-018).
 */
function droppedView(dropped: readonly MigrationDrop[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'import-dropped migrate-dropped';

  const heading = document.createElement('p');
  heading.className = 'import-dropped-heading migrate-dropped-heading';
  heading.textContent = message('migratePlanDropped', [String(dropped.length)]);

  const list = document.createElement('ul');
  for (const drop of dropped) {
    const item = document.createElement('li');
    // `textContent`, always: every parameter here came out of the user's
    // backup, and a field named `<img onerror=…>` is a name.
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
 * Everything that arrives changed, beside the drops and never inside them
 * (A3, FR-056).
 *
 * The same shape as the import's notes list, for the reason its heading
 * exists: the two are read as one glance at a heading and a count, and a
 * reader who has to parse each sentence to learn whether the entry
 * survives has been given a worse preview than no list at all.
 */
function notedView(noted: readonly MigrationNote[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'import-noted migrate-noted';

  const heading = document.createElement('p');
  heading.className = 'import-noted-heading migrate-noted-heading';
  heading.textContent = message('migratePlanNoted', [String(noted.length)]);

  const list = document.createElement('ul');
  for (const note of noted) {
    const item = document.createElement('li');
    // As in `droppedView`: every parameter came out of the user's backup, so
    // it is written as text and can never become markup. Two joinings, both
    // deliberate: the fault (where there is one) is resolved by
    // `problemText` and appended, so the catalog decides where in the
    // sentence it lands; and a field's losses are each resolved against
    // their own `migrateLoss*` key before being joined into the frame's
    // $LOSSES$ slot — the wording of "min and max reordered" belongs to the
    // catalog exactly as the sentence around it does, for `problems.ts`'s
    // reason: a frame that can be translated with a payload that never
    // could be is a sentence no translation will ever complete (NFR-018).
    const frame = [
      ...note.params,
      note.losses === undefined
        ? undefined
        : note.losses.map((loss) => message(loss.code, loss.params)).join('; '),
      note.problem === undefined ? undefined : problemText(note.problem),
    ].filter((part): part is string => part !== undefined);
    item.textContent = message(note.code, frame);
    list.append(item);
  }

  section.append(heading, list);
  return section;
}

/**
 * The summary's "what is there now" half, patched in place after a save
 * (BR-026-5's liveness, the third surface and the same fix as its siblings).
 *
 * The restore confirmation's counts and the import preview's current half
 * both went stale across this page's own saves until review caught it, and
 * this summary is built from the same live settings they are — a rule added
 * while it read one rule was going to be replaced as one. Same hook, same
 * contract: the current half is recomputed from live settings, the incoming
 * half and the file's name are read back off the element the render wrote
 * them on, nothing else is touched.
 *
 * A no-op with no report on screen. Refusals carry nothing derived from the
 * running settings, and the chooser is a control the refresh contract says
 * is never rebuilt.
 */
export function refreshMigrate(host: OptionsHost, into: HTMLElement): void {
  const summary = into.querySelector('.migrate-summary');
  if (!(summary instanceof HTMLElement)) return;

  const incomingRules = summary.dataset['incomingRules'];
  const incomingProfiles = summary.dataset['incomingProfiles'];
  const file = summary.dataset['file'];
  if (incomingRules === undefined || incomingProfiles === undefined || file === undefined) return;

  const current = host.settings();
  summary.textContent = message('migratePlanSummary', [
    String(current.rules.length),
    String(current.profiles.length),
    incomingRules,
    incomingProfiles,
    file,
  ]);
}

/**
 * Step 7: one write, or none (BR-027-1).
 *
 * `host.replace` is the import's single-replacement write, and it is
 * load-bearing here for UC-028's reason as well as UC-026's: it settles
 * when storage has, so A7 can say the migration did not happen rather
 * than guess, and on a rejected write the previous configuration is still
 * in force because nothing partial was ever written.
 */
async function apply(
  host: OptionsHost,
  into: HTMLElement,
  name: string,
  plan: MigrationPlan,
): Promise<void> {
  try {
    await host.replace(plan.settings);
  } catch {
    // Announced by `replace` itself, in the same words every other
    // rejected write on this page uses. The plan stays on screen, which is
    // exactly what a retry needs.
    return;
  }

  // Only now. Clearing the file first would leave a failed migration with
  // nothing on screen to retry from.
  pending = undefined;
  host.redraw();
  host.announce(
    message('migrateDone', [String(plan.incoming.rules), String(plan.incoming.profiles), name]),
  );
  // The redraw destroyed the focused button; back to the chooser, where a
  // second migration would start.
  focusIn(into, '.migrate-file');
}
