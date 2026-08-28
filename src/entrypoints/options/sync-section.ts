import { message } from '@/lib/platform/i18n';
import type { Settings } from '@/lib/settings';
import {
  readReplicaItems,
  readSyncPrefs,
  writeSyncChoice,
} from '@/lib/platform/sync-store';
import {
  readReplica,
  sameConfiguration,
  syncSides,
  SYNC_RULE_CEILING,
  SYNC_SHARD_SIZE,
  type SyncOutcome,
  type SyncPrefs,
} from '@/lib/sync';
import { checkbox, focusIn } from './controls';
import { reason } from './reason';
import type { OptionsHost } from './host';

/**
 * UC-029 — the browser's own synchronised storage, opted into per device.
 *
 * Its own module for the reason the portability trio each have one: nothing here
 * edits a slice of the settings state. The toggle is not a setting — it is
 * stored locally and deliberately never carried (BR-029-1) — and the rest of the
 * section is a decision (step 3) and a status line, neither of which is the
 * shape a settings section has.
 *
 * **Two sentences are permanent text, not an acknowledgement** (BR-029-3).
 * Synchronisation stops at roughly 399 rules, and a conflict discards up to
 * eight. Both describe the feature's ordinary operation rather than an error
 * state, so both are on screen before the toggle is ever switched on, and
 * neither lives in a dialogue the user clicks through once. They are the reason
 * this section renders anything at all when synchronisation is off.
 *
 * **The status line says written, refused, or stopped — never "up to date"**
 * (BR-029-6, A4). Whether another device received anything is a fact about the
 * user's browser account that no extension API reports, and a screen asserting
 * it would be exactly the failure FR-059 exists to prevent, in the confident
 * direction. Everything below is a statement about this device's own writes.
 *
 * This section holds no state of its own beyond step 3's answer being
 * outstanding, which is itself in the preferences rather than here: a choice
 * that lived in module scope would be forgotten by closing the tab, and the
 * device would go back to synchronising nothing with no record of why.
 */

/**
 * The preferences and the replica, as the last render read them.
 *
 * Both are asynchronous and the section renders synchronously, like every other
 * section on this page. Rather than make the whole registry async for one
 * caller, the render draws from this cache and asks for a refresh; the answer
 * arrives a frame later and re-renders. The first paint is therefore the
 * shipped defaults — synchronisation off, both standing sentences present —
 * which is the correct thing to show while the question is outstanding rather
 * than a placeholder.
 */
let prefs: SyncPrefs | undefined;
let replicaSettings: Settings | undefined;
let replicaState: string = 'empty';
let loading = false;

export function renderSync(host: OptionsHost, into: HTMLElement): void {
  void load(host, into);

  const view = document.createElement('div');
  view.className = 'sync-view';
  view.append(toggle(host, into));

  if (prefs?.choicePending === true) view.append(choiceView(host, into));

  view.append(statusLine(), standingSentences());
  into.replaceChildren(view);
}

/**
 * Reads both stores and re-renders once, guarded against re-entry.
 *
 * The guard is what keeps this from looping: `renderSync` starts a load and a
 * load ends in a `renderSync`. Without it the section would redraw for as long
 * as the page was open, which is a busy loop that looks exactly like a working
 * page until something else needs the main thread.
 */
async function load(host: OptionsHost, into: HTMLElement): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const [next, read] = await Promise.all([readSyncPrefs(), readReplicaItems()]);

    // A failed read leaves the last known replica state alone rather than
    // recording it as empty. Nothing on this page acts on `replicaState`
    // destructively, but the preferences half of this load is still worth
    // taking: the status line is how the user finds out the store could not be
    // read, and it is written by the background.
    const replica = read.ok ? readReplica(read.items) : undefined;
    const changed =
      JSON.stringify(next) !== JSON.stringify(prefs) ||
      (replica !== undefined && replica.state !== replicaState);
    prefs = next;
    if (replica !== undefined) {
      replicaState = replica.state;
      replicaSettings = replica.state === 'usable' ? replica.settings : undefined;
    }
    if (changed) renderSync(host, into);
  } catch {
    // Neither store answered. The section keeps the last state it drew, and the
    // standing sentences — which are true regardless — are already on screen.
  } finally {
    loading = false;
  }
}

/**
 * Step 1: off by default, and decided on each device.
 *
 * Not `host.save`, and that is the whole of BR-029-1 in one line: this is not
 * part of the settings state, so it is not exported, not imported, not restored
 * and above all not synchronised. A toggle that travelled would switch the
 * feature off everywhere the moment one device opted out.
 */
function toggle(host: OptionsHost, into: HTMLElement): HTMLElement {
  return checkbox(
    message('syncEnableLabel'),
    prefs?.enabled === true,
    (value) => {
      void (value ? enable(host, into) : disable(host, into));
    },
    message('syncEnableHint'),
  );
}

/**
 * Steps 2 and 3: look at what the store holds before writing anything to it.
 *
 * Three outcomes, and only one of them asks a question. An empty or unusable
 * store is seeded from this device, which needs no consent — nothing is
 * discarded. A store holding the *same* configuration needs none either, and
 * asking would be offering a choice between two identical answers. A store
 * holding something different is the case step 3 is about, and nothing is
 * written in either direction until the user says which one wins.
 */
async function enable(host: OptionsHost, into: HTMLElement): Promise<void> {
  const read = await readReplicaItems();

  /**
   * **A store that could not be read is not an empty store**, and this is the
   * surface where confusing them costs most.
   *
   * The failed read used to arrive as `{}`, which reads as empty, which is the
   * one state that needs no consent — so a transient failure here skipped step
   * 3's question entirely and marked the configuration for seeding, over a store
   * that may have been holding a different one all along. Consent over an
   * unknown state is not consent, so the feature is not switched on at all: the
   * toggle goes back, the reason is said, and trying again costs one click.
   */
  if (!read.ok) {
    // The re-render puts the toggle back to off, which destroys the control that
    // was just clicked — so the focus is placed deliberately rather than left on
    // `<body>`. This page's rule everywhere it removes a control (WCAG 2.4.3,
    // NFR-019), and here it also returns the user to the thing they would press
    // to try again.
    renderSync(host, into);
    host.announce(message('syncEnableUnreadable', [reason(read.reason)]));
    focusIn(into, '.sync-view input[type="checkbox"]');
    return;
  }

  const replica = readReplica(read.items);
  const different = replica.state === 'usable' && !sameConfiguration(replica.settings, host.settings());

  // Only the user's half. Nothing here writes the replica and nothing here
  // claims there is something to send: switching the feature on is what the
  // engine watches for (`wakesEngine`), and the flush it provokes computes the
  // delta and records `pending` for itself. That division is what leaves each
  // preferences key with exactly one writer — BR-029-2's discipline, applied to
  // the local key as well as to the synchronised one.
  prefs = await writeSyncChoice({ enabled: true, choicePending: different });
  renderSync(host, into);
  host.announce(message(different ? 'syncChoiceNeeded' : 'syncEnabled'));
  if (different) focusIn(into, '.sync-keep-here');
}

/**
 * A5: local storage stays authoritative and the replica is left exactly as it is.
 *
 * Clearing it was considered and is refused. Turning the feature off on this
 * device must not reach into another device's configuration, and a `clear` here
 * would do precisely that — the next laptop to come online would find an empty
 * store where its own configuration used to be carried, having been switched off
 * by a decision made somewhere it cannot see.
 */
async function disable(host: OptionsHost, into: HTMLElement): Promise<void> {
  prefs = await writeSyncChoice({ enabled: false, choicePending: false });
  renderSync(host, into);
  host.announce(message('syncDisabled'));
}

/**
 * Step 3: both sides in one sentence, and the choice that resolves it.
 *
 * Counts rather than a difference, matching UC-028's confirmation: the user is
 * deciding which of two configurations survives, and "31 rules and 4 profiles
 * here, 12 and 1 there" is a decision they can make where a list of differences
 * is one they would have to study. Neither button is primary — this is a choice
 * between two answers rather than a confirmation of one, and styling one of them
 * as the recommendation would be a recommendation nobody is entitled to make.
 */
function choiceView(host: OptionsHost, into: HTMLElement): HTMLElement {
  const view = document.createElement('div');
  view.className = 'sync-choice';

  const summary = document.createElement('p');
  summary.className = 'sync-choice-summary';
  const sides = syncSides(host.settings(), replicaSettings ?? host.settings());
  summary.textContent = message('syncChoiceSides', [
    String(sides.here.rules),
    String(sides.here.profiles),
    String(sides.there.rules),
    String(sides.there.profiles),
  ]);
  view.append(summary);

  const actions = document.createElement('div');
  actions.className = 'sync-choice-actions';

  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'sync-keep-here';
  keep.textContent = message('syncChoiceKeepHere');
  keep.addEventListener('click', () => {
    void chooseHere(host, into);
  });

  const take = document.createElement('button');
  take.type = 'button';
  take.className = 'sync-take-there';
  take.textContent = message('syncChoiceTakeThere');
  take.addEventListener('click', () => {
    void chooseThere(host, into);
  });

  actions.append(keep, take);
  view.append(actions);
  return view;
}

/** This device wins: the replica is overwritten on the next flush, which the pending flag asks for. */
async function chooseHere(host: OptionsHost, into: HTMLElement): Promise<void> {
  prefs = await writeSyncChoice({ choicePending: false });
  renderSync(host, into);
  host.announce(message('syncChoiceKeptHere'));
  focusIn(into, '.sync-view input[type="checkbox"]');
}

/**
 * The store wins: applied here through the same single replacement an import uses.
 *
 * `host.replace` rather than a write of our own, for its two properties. It
 * settles when storage has, so a rejected write is reported as the adoption not
 * having happened rather than guessed at; and it rolls this page's memory back,
 * without which every other section would go on computing its next save from a
 * configuration storage never accepted.
 */
async function chooseThere(host: OptionsHost, into: HTMLElement): Promise<void> {
  const settings = replicaSettings;
  if (settings === undefined) {
    // The replica stopped being usable while the question was on screen. Nothing
    // is written and the choice is withdrawn rather than answered wrongly.
    prefs = await writeSyncChoice({ choicePending: false });
    renderSync(host, into);
    host.announce(message('syncChoiceGone'));
    return;
  }

  try {
    await host.replace(settings);
  } catch {
    // Announced by `replace` in the same words every rejected write uses. The
    // choice stays on screen, which is what a retry needs.
    return;
  }

  prefs = await writeSyncChoice({ choicePending: false });
  host.redraw();
  host.announce(message('syncChoiceTookThere'));
  focusIn(into, '.sync-view input[type="checkbox"]');
}

/**
 * What this device's last write did — and nothing about any other device.
 *
 * The vocabulary is closed by the type rather than by discipline: a `switch`
 * with no `default` over `SyncOutcome`, so a sixth outcome is a compile error
 * here rather than a status line that silently says nothing. That matters more
 * than usual on this surface, because the failure mode BR-029-6 is guarding
 * against is a screen that reassures.
 */
function statusLine(): HTMLElement {
  const line = document.createElement('p');
  line.className = 'sync-status';
  line.textContent = statusText();
  return line;
}

function statusText(): string {
  if (prefs?.enabled !== true) return message('syncStatusOff');
  if (prefs.choicePending) return message('syncStatusChoice');

  const outcome: SyncOutcome = prefs.outcome;
  switch (outcome.kind) {
    case 'idle':
      return message('syncStatusIdle');
    case 'waiting':
      return message('syncStatusWaiting');
    case 'written':
      return message('syncStatusWritten');
    case 'adopted':
      return message('syncStatusAdopted');
    case 'stopped':
      // A1's third sentence: what stopped it, in rules, and what restores it.
      return message('syncStatusStopped', [String(outcome.rules), String(SYNC_RULE_CEILING)]);
    case 'refused':
      return message('syncStatusRefused', [reason(outcome.reason)]);
    case 'unreadable':
      // Not the same fact as a refused write, and not the same sentence: the
      // store said nothing rather than saying no, and nothing was attempted.
      return message('syncStatusUnreadable', [reason(outcome.reason)]);
    case 'arrival-unsaved':
      // The one outcome on this screen that is not about the synchronised store
      // at all. Reporting it as a refusal named the wrong subject and sent the
      // user to look at the wrong thing (NFR-020).
      return message('syncStatusArrivalUnsaved', [reason(outcome.reason)]);
  }
}

/**
 * BR-029-3's two sentences, drawn every time because they are true every time.
 *
 * Both are stated in the terms the user will meet them in — rules, not bytes,
 * and "up to eight" rather than "one shard". The shard size is substituted from
 * the constant the layout actually uses, so the screen cannot come to disagree
 * with the store the day that number is revisited.
 */
function standingSentences(): HTMLElement {
  const view = document.createElement('div');
  view.className = 'sync-standing';

  const ceiling = document.createElement('p');
  ceiling.className = 'hint sync-standing-ceiling';
  ceiling.textContent = message('syncStandingCeiling', [String(SYNC_RULE_CEILING)]);

  const conflict = document.createElement('p');
  conflict.className = 'hint sync-standing-conflict';
  conflict.textContent = message('syncStandingConflict', [String(SYNC_SHARD_SIZE)]);

  view.append(ceiling, conflict);
  return view;
}

/**
 * The status and the choice's counts, patched in place — the render the page
 * owes a section it is not allowed to rebuild.
 *
 * Three callers, one contract, and it is the lesson UC-027's review round left:
 * a section that grows computed text over live settings without a refresh is a
 * failing test rather than a lying sentence. The adoption render skips whatever
 * holds the focus, and step 3 deliberately focuses one of its two buttons;
 * `host.save` renders nothing at all, because a rebuild would take the caret,
 * and an edit made anywhere else on this page moves the counts step 3 is
 * offering a decision over. No control is rebuilt here, so the focus each of
 * those callers is protecting survives.
 *
 * The preferences are re-read as well, because this section's other half of
 * computed text does not come from settings at all: the background writes the
 * outcome, and this page finds out the same way it finds out about a foreign
 * settings write.
 */
export function refreshSync(host: OptionsHost, into: HTMLElement): void {
  const status = into.querySelector('.sync-status');
  if (status !== null) status.textContent = statusText();

  const summary = into.querySelector('.sync-choice-summary');
  if (summary !== null) {
    const sides = syncSides(host.settings(), replicaSettings ?? host.settings());
    summary.textContent = message('syncChoiceSides', [
      String(sides.here.rules),
      String(sides.here.profiles),
      String(sides.there.rules),
      String(sides.there.profiles),
    ]);
  }

  void load(host, into);
}
