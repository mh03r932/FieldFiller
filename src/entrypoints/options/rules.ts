import { message, type MessageKey } from '@/lib/platform/i18n';
import { GENERATOR_BOUNDS, MATCH_SOURCES, type Generator, type MatchSource, type Rule, type Settings } from '@/lib/settings';
import {
  addRule,
  changeGeneratorType,
  moveRule,
  removeRule,
  replaceRule,
  restoreRule,
  sampleRule,
} from '@/lib/rules/editing';
import { validateRule, type RuleProblem } from '@/lib/rules/validate';
import { checkbox, field, focusIn, numberInput, select, textArea, textInput } from './controls';
import type { OptionsHost } from './host';
import type { Locale } from '@/lib/persona/persona';

/**
 * The rule editor (UC-009..UC-013).
 *
 * Plain DOM and no dependencies, which is the same reason the rest of this
 * extension has none: G4's verifiable build and the "nothing to audit" claim are
 * worth more than the convenience, and a list with a form in it is not where a
 * framework earns its keep.
 *
 * Everything that decides *what* the list becomes lives in `lib/rules/editing`
 * as pure functions over a rule array. This file renders and listens. That split
 * is what lets the behaviour be tested without a page, and it is why the
 * interesting assertions in `tests/editing.test.ts` are not DOM assertions.
 *
 * Saving is per change and never staged (BR-009-1). An edit that validates is
 * written; one that does not shows its problem beside the field that caused it
 * and is not written, which is what makes FR-070's "rejected when you save"
 * literally true when every keystroke is a save.
 */

/**
 * The rule editor takes the same host every other section does.
 *
 * Kept as a name of its own because this module's exports read as an editor's
 * API and `OptionsHost` is the page's; they have never differed and there is no
 * reason for them to.
 */
export type RuleEditorHost = OptionsHost;

/**
 * Where a rule list lives inside the settings (UC-015).
 *
 * The editor was written against `settings.rules` directly, which was right
 * while that was the only rule list there was. Profiles give each their own, and
 * the whole of this file — create, edit, delete, reorder, preview, undo,
 * validation, the draft — applies to a profile's rules unchanged. Duplicating
 * 700 lines to change one property access would guarantee the two drifted, and
 * the first divergence would be a profile rule that could be written but not
 * validated the same way.
 *
 * `key` is what keeps two lists apart where the editor holds state outside the
 * DOM: an undo offer belongs to the list it was deleted from, and restoring a
 * rule into a different list would put it at a position chosen for another one.
 * Rule ids are UUIDs, so nothing else needs the distinction — one rule is open
 * at a time across the whole page, which is the existing design and stays true.
 */
export type RuleLens = {
  readonly key: string;
  readonly read: (settings: Settings) => readonly Rule[];
  readonly write: (settings: Settings, rules: readonly Rule[]) => Settings;
};

/** The global rule list — the one that existed before profiles. */
export const GLOBAL_RULES: RuleLens = {
  key: 'global',
  read: (settings) => settings.rules,
  write: (settings, rules) => ({ ...settings, rules }),
};

/** The rule list of one profile, by id. */
export function profileRules(profileId: string): RuleLens {
  return {
    key: `profile:${profileId}`,
    read: (settings) => settings.profiles.find((p) => p.id === profileId)?.rules ?? [],
    write: (settings, rules) => ({
      ...settings,
      profiles: settings.profiles.map((p) => (p.id === profileId ? { ...p, rules } : p)),
    }),
  };
}

/**
 * The rule being edited, and everything about it that has to outlive a render.
 *
 * One record rather than three variables, because the three have to agree and
 * nothing made them. The lens used to be assigned on *every render* while the id
 * and the draft were assigned on every *open*, and a render is not an open:
 * expanding a profile draws that profile's rule list, so merely looking at a
 * profile while a global rule was open repointed the lens at the profile — and
 * the next foreign write then carried the global draft into the profile's rules
 * at top precedence. The global list's own reorder and delete handlers did the
 * same to a rule open inside a profile. Written together and cleared together,
 * that disagreement is not reachable (BR-015-2).
 */
type OpenRule = {
  /** Which rule is expanded. One at a time: the list is the context (UC-009). */
  readonly id: string;

  /**
   * The list it was opened from (BR-015-2).
   *
   * The page's storage listener adopts another writer's settings and has to
   * carry the draft across, but it is one listener for the whole page and cannot
   * know which of several lists is being edited. A lens is a plain value over an
   * id, so it survives the rebuild that destroys every closure a render made —
   * which is what the per-render assignment was for, and did not need to be.
   */
  readonly lens: RuleLens;

  /**
   * The rule as it has been typed, which is not always what is stored.
   *
   * An edit is written only when it validates (BR-009-1), so while a rule is
   * invalid the stored list still holds the last good version — and a *new* rule
   * is invalid from the moment it appears, because it has no pattern yet. That
   * is the ordinary state of a rule being written, not an edge case.
   *
   * A structural edit rebuilds the whole list, and the rebuild reads the stored
   * rules. Without the draft kept here it read the last committed version, so
   * choosing a generator type before typing a pattern — a natural first move —
   * drew the choice straight back to what it had been, and unticking "whatever
   * is enabled globally" on a rule not yet valid revealed nothing, putting
   * FR-067 out of reach until the rule validated. Worse, a rule invalid for an
   * unrelated reason lost every uncommitted keystroke in the open editor to any
   * structural edit, which is the discarding UC-009 A3 sanctions only when the
   * page closes.
   *
   * Outside the DOM for the same reason the id is: it has to survive the rebuild
   * that destroys the editor holding it. It never reaches storage — the commit
   * path is still the only writer, and it still refuses invalid rules.
   */
  readonly draft?: Rule;
};

let editing: OpenRule | undefined;

/**
 * Whether a rule is open for editing.
 *
 * Exported for the page's storage listener, which adopts another writer's
 * settings only when nothing is being edited here — replacing the list under
 * someone mid-edit would discard the rule they are still writing, which is a
 * worse outcome than the staleness it fixes.
 */
export function isEditingRule(): boolean {
  return editing !== undefined;
}

/**
 * Closes the open rule when it belongs to a list that is going away (UC-015).
 *
 * A profile's rules are drawn inside the profile's own editor, so collapsing the
 * profile — or deleting it — destroys the rule editor's DOM. Nothing destroyed
 * this state with it, and the consequences outlived the screen: `isEditingRule`
 * went on answering yes forever, so the page's storage listener took the "adopt
 * into memory, do not re-render" branch for the rest of the session and the
 * global list stopped refreshing on foreign writes altogether — while every
 * adoption kept carrying a draft whose editor no longer existed.
 *
 * Keyed by lens rather than by rule id, because the caller knows which list it
 * is dismantling and not what happens to be open inside it. A rule open in some
 * *other* list is left alone, which is the whole point of asking.
 */
export function closeRuleIn(key: string): void {
  if (editing?.lens.key === key) editing = undefined;
}

/**
 * Closes whatever rule is open, whichever list it belongs to (UC-026).
 *
 * `closeRuleIn` asks about one list because its callers are dismantling one.
 * An import dismantles all of them: the global list and every profile's list
 * are replaced at once, so there is no list left for an open editor to belong
 * to. Left set, `isEditingRule` would go on answering yes over a rule the page
 * no longer draws, which is the stuck state `closeRuleIn` was written for,
 * reached through the one door it cannot close.
 */
export function closeAnyRule(): void {
  editing = undefined;
}

/** The last deletion, for as long as this page stays open (UC-011). */
let undoable: { readonly rule: Rule; readonly at: number; readonly key: string } | undefined;

/**
 * Drops the undo offer, for when the list it belonged to is gone (UC-011, UC-024).
 *
 * The offer holds a rule *and the position it held*, which only means something
 * against the list it was deleted from. When this page adopts settings written
 * elsewhere it is a different list, so restoring would put a rule back at an
 * index chosen for a list that no longer exists — `restoreRule` clamps, so it
 * misplaces rather than throws, which is the worse of the two.
 */
export function forgetUndo(list: HTMLElement): void {
  undoable = undefined;
  // Taken off the screen, not merely out of the state. The caller that needs
  // this most — adopting another writer's settings while a rule is open —
  // deliberately does not re-render, so the offer and its handler would stay
  // live over a list they no longer describe. Clearing the state alone left the
  // button sitting there, which is the hazard this function's own reason for
  // existing says must not remain.
  list.querySelector('.undo')?.remove();
}

/**
 * Another writer's settings, with the rule being edited here carried across.
 *
 * The page cannot simply take `stored` while a rule is open. A rule that has
 * never validated exists only in this page's memory — a new one starts with an
 * empty pattern, which the parser drops — so adopting wholesale deletes the
 * thing the user is in the middle of typing. It cannot keep its own snapshot
 * either: the next valid keystroke writes the whole of it back and reverts
 * whatever the other writer did.
 *
 * So it takes theirs and puts the draft back. Position comes from *our* list,
 * because that is where the user last saw it, and `restoreRule` clamps it into
 * range if their list is shorter. Order is precedence (BR-009-2), so this is a
 * guess about meaning rather than a cosmetic choice — but the alternatives are
 * dropping the rule or dropping their changes, and this is the only one that
 * keeps both.
 *
 * The caller does not re-render. What is on screen stays as it was until the
 * rule closes, which is the point: the DOM is the thing that cannot be replaced
 * under an open editor without taking the caret with it.
 */
export function adoptKeepingEdit(stored: Settings, mine: Settings): Settings {
  if (editing === undefined) return stored;

  // Through the lens the open rule was *opened from*, which is not always the
  // global list now that a profile has one of its own (UC-015), and is never
  // whichever list happened to be drawn last. Reading `.rules` here while the
  // user edits a profile rule would carry the draft into the wrong list —
  // creating a duplicate global rule and losing the profile edit, which is both
  // halves of what this function exists to prevent.
  const { id, lens } = editing;
  const theirs = lens.read(stored);
  const ours = lens.read(mine);

  // What was typed, falling back to what was stored. A rule that has not
  // validated since it was opened exists only as a draft, so taking the stored
  // copy here would carry across a version the user has already moved past.
  const draft = editing.draft ?? ours.find((rule) => rule.id === id);
  if (draft === undefined) return stored;

  // They have it too: ours is the newer text, theirs is the position.
  if (theirs.some((rule) => rule.id === id)) {
    return lens.write(
      stored,
      theirs.map((rule) => (rule.id === id ? draft : rule)),
    );
  }

  // They do not: it is new here, or they deleted it. Either way it is what the
  // user is looking at, and dropping it would lose an edit in progress — where
  // keeping it costs them a rule reappearing, which they can delete again.
  //
  // A profile the other writer deleted outright is the one case with nothing to
  // write back to: `lens.write` finds no profile with that id and returns their
  // state unchanged, so the draft is dropped. That is the right outcome — the
  // list it belonged to is gone, and resurrecting a profile because someone had
  // one of its rules open would undo a deletion nobody asked to undo.
  const at = ours.findIndex((rule) => rule.id === id);
  return lens.write(stored, restoreRule(theirs, draft, at));
}

/**
 * Builds the list into `into`, which is also what every handler re-renders.
 *
 * `into` is threaded down rather than re-found: the handlers used to reach back
 * up with `item.closest('#rules')`, so this module was handed its container and
 * then went looking for it by an ID hard-coded in four places. Renaming the host
 * element would have left the editor rendering once and never again, silently
 * and with no type error — the coupling was invisible precisely because the
 * selector kept working.
 */
export function renderRules(
  host: RuleEditorHost,
  into: HTMLElement,
  lens: RuleLens = GLOBAL_RULES,
): void {
  const rules = lens.read(host.settings());
  into.replaceChildren();

  if (rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    // Not "you have nothing" — no rules is a working configuration, and saying
    // so is the difference between an empty state and a broken-looking one.
    empty.textContent = message('rulesEmpty');
    into.append(empty);
  } else {
    const list = document.createElement('ol');
    list.className = 'rule-list';
    for (const [index, rule] of rules.entries()) {
      // The open rule is drawn as typed rather than as stored. They differ
      // exactly while it is invalid, which is most of the time it is being
      // written — see `OpenRule.draft`.
      const shown = editing?.id === rule.id ? (editing.draft ?? rule) : rule;
      list.append(ruleRow(host, shown, index, rules.length, into, lens));
    }
    into.append(list);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary';
  add.textContent = message('ruleAdd');
  add.addEventListener('click', () => {
    const id = crypto.randomUUID();
    // Appended, never inserted: first match wins, so any other position would
    // change what the existing rules do (BR-009-2).
    commit(host, lens, addRule(lens.read(host.settings()), id));
    editing = { id, lens };
    renderRules(host, into, lens);
    into.querySelector<HTMLInputElement>(`[data-rule="${id}"] input`)?.focus();
  });
  into.append(add);

  // Only the list it was deleted from. An offer rendered under a different list
  // would restore a rule into a list it never belonged to, at a position chosen
  // for another one.
  if (undoable !== undefined && undoable.key === lens.key) {
    into.append(undoOffer(host, into, lens));
  }
}

function undoOffer(host: RuleEditorHost, into: HTMLElement, lens: RuleLens): HTMLElement {
  const removed = undoable!;
  const bar = document.createElement('p');
  bar.className = 'undo';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = message('ruleDeleted', [nameOf(removed.rule)]);

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = message('ruleUndo');
  undo.addEventListener('click', () => {
    // The state, not the value captured when this was drawn. If the offer has
    // been withdrawn since — the list it belonged to was replaced by another
    // writer's — then this button is a leftover and restoring would insert at a
    // position chosen for a list that no longer exists.
    if (undoable === undefined) {
      bar.remove();
      return;
    }
    // Back to the position it held, not to the end: order is meaning, and the
    // user asked to undo rather than to re-add (BR-011-2).
    commit(host, lens, restoreRule(lens.read(host.settings()), removed.rule, removed.at));
    undoable = undefined;
    renderRules(host, into, lens);
    // Onto the rule that came back, which is both where the user was looking and
    // the only way to confirm by keyboard that it returned to the right place.
    focusIn(into, `[data-rule="${removed.rule.id}"] .rule-name`);
  });

  bar.append(text, undo);
  return bar;
}

function ruleRow(
  host: RuleEditorHost,
  rule: Rule,
  index: number,
  total: number,
  list: HTMLElement,
  lens: RuleLens,
): HTMLElement {
  const item = document.createElement('li');
  item.className = 'rule';
  item.dataset['rule'] = rule.id;

  const header = document.createElement('div');
  header.className = 'rule-header';

  const disclose = document.createElement('button');
  disclose.type = 'button';
  disclose.className = 'rule-name';
  disclose.setAttribute('aria-expanded', String(editing?.id === rule.id));
  disclose.textContent = nameOf(rule);
  disclose.addEventListener('click', () => {
    // Closing discards what never validated, and opening another rule starts
    // from what is stored — both the behaviour before the draft existed. The
    // lens is recorded here, at the one moment that knows which list the user
    // reached this rule through (BR-015-2).
    editing = editing?.id === rule.id ? undefined : { id: rule.id, lens };
    renderRules(host, list, lens);
    // Back onto this same button, which the rebuild destroyed. Expanding a rule
    // by keyboard otherwise left the focus on `<body>`, so the next Tab started
    // again from the top of the page — and the editor that just opened was below
    // the point focus had been (WCAG 2.4.3, NFR-019).
    focusIn(list, `[data-rule="${rule.id}"] .rule-name`);
  });

  const problems = validateRule(rule);
  if (problems.length > 0) {
    const flag = document.createElement('span');
    flag.className = 'rule-flag';
    flag.textContent = '!';
    flag.title = problemText(problems[0]!);
    disclose.append(flag);
  }

  header.append(
    disclose,
    ordering(host, rule, index, total, list, lens),
    remove(host, rule, index, list, lens),
  );
  item.append(header);

  if (editing?.id === rule.id) item.append(editor(host, rule, item, list, lens));
  return item;
}

/**
 * Move up and move down (UC-012).
 *
 * Buttons rather than a drag, and not as an accommodation: this *is* the
 * interaction (BR-012-1). The reference used a drag library since deprecated for
 * accessibility regressions, and the cheapest way to satisfy NFR-019 here is to
 * need nothing. Focus stays on the moved rule so a second move needs no
 * re-aiming, and the new position is announced (BR-012-2).
 */
function ordering(
  host: RuleEditorHost,
  rule: Rule,
  index: number,
  total: number,
  list: HTMLElement,
  lens: RuleLens,
): HTMLElement {
  const group = document.createElement('span');
  group.className = 'rule-order';

  for (const [direction, key, disabled] of [
    [-1, 'ruleMoveUp', index === 0],
    [1, 'ruleMoveDown', index === total - 1],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = direction === -1 ? '↑' : '↓';
    // Named so the rebuild below can return the focus to *this* button rather
    // than to whichever one comes first in the DOM.
    button.dataset['direction'] = direction === -1 ? 'up' : 'down';
    // A visible label would repeat for every rule; the accessible name carries
    // it instead, and the title makes it discoverable with a pointer.
    button.setAttribute('aria-label', `${message(key)}: ${nameOf(rule)}`);
    button.title = message(key);
    // Unavailable rather than inert, so the limit is visible before it is
    // reached (UC-012 A1).
    button.disabled = disabled;
    button.addEventListener('click', () => {
      const moved = moveRule(lens.read(host.settings()), rule.id, direction);
      commit(host, lens, moved);
      const position = moved.findIndex((candidate) => candidate.id === rule.id) + 1;
      host.announce(message('ruleMoved', [nameOf(rule), String(position), String(moved.length)]));

      renderRules(host, list, lens);
      // The button that was pressed, not the first one still enabled. Those
      // differ for every rule but the first: `button:not(:disabled)` is the up
      // arrow, so moving a rule *down* handed the focus to up, and a second
      // press of the same key moved it straight back — the opposite of what
      // UC-012 step 3 asks for, and invisible unless you are working by
      // keyboard.
      //
      // The fallback is not a nicety: a rule moved to either end has the
      // button that moved it disabled, and focus would otherwise be dropped on
      // the body, which for a keyboard user means starting again from the top
      // of the page.
      const rowSelector = `[data-rule="${rule.id}"] .rule-order button`;
      const pressed = list.querySelector<HTMLButtonElement>(
        `${rowSelector}[data-direction="${direction === -1 ? 'up' : 'down'}"]`,
      );
      const target =
        pressed !== null && !pressed.disabled
          ? pressed
          : list.querySelector<HTMLButtonElement>(`${rowSelector}:not(:disabled)`);
      target?.focus();
    });
    group.append(button);
  }
  return group;
}

function remove(
  host: RuleEditorHost,
  rule: Rule,
  index: number,
  list: HTMLElement,
  lens: RuleLens,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rule-delete';
  button.textContent = message('ruleDelete');
  button.setAttribute('aria-label', `${message('ruleDelete')}: ${nameOf(rule)}`);
  button.addEventListener('click', () => {
    // Immediate and reversible rather than confirmed and permanent: a
    // confirmation taxes every user to protect the one who misclicked
    // (BR-011-1).
    undoable = { rule, at: index, key: lens.key };
    commit(host, lens, removeRule(lens.read(host.settings()), rule.id));
    if (editing?.id === rule.id) editing = undefined;
    renderRules(host, list, lens);
    // Onto Undo, not nowhere. The button that was pressed no longer exists, and
    // the offer that replaces it is the thing a person who has just deleted the
    // wrong rule wants — but it renders at the end of the list, so a keyboard
    // user with focus dropped on `<body>` would have to tab past every remaining
    // rule to reach it, which for the reversal BR-011-1 is built on is too late
    // to be useful.
    focusIn(list, '.undo button');
  });
  return button;
}

function editor(
  host: RuleEditorHost,
  rule: Rule,
  item: HTMLElement,
  list: HTMLElement,
  lens: RuleLens,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'rule-body';

  /**
   * The rule as it is *now*, not as it was when these controls were built.
   *
   * Every handler below spreads from this. Closing over the render-time rule
   * instead — which is what this did first — means the second edit is applied to
   * the state before the first, so typing a name and then a pattern silently
   * discards the name. Ordinary edits deliberately do not re-render the fields
   * (it would take the caret with them), so the snapshot they captured would
   * stay stale for as long as the editor was open.
   *
   * Found by the options-page harness, which types into two fields in a row —
   * the first sequence of interactions that could see it.
   */
  let current = rule;
  const live = (): Rule => current;

  /**
   * `refocus` marks an edit that changes the *set* of fields, not their values.
   *
   * Ordinary edits re-render only the preview and the problems, because
   * rebuilding the form on every keystroke would take the focus and the caret
   * with it and make a text field unusable. A few edits genuinely change which
   * fields exist, and those have to rebuild the body — so they say where the
   * focus belongs afterwards, because a rebuild that drops the user at the top
   * of the page is its own defect.
   *
   * There are exactly two, and both were found the same way — by the state
   * changing while the controls that display it did not:
   *
   *   · the generator type. A date has a format where a regex has a pattern.
   *     Without this the new type's fields never appeared and the rule kept the
   *     previous type's editor while storing the new type's defaults. Caught by
   *     the options-page harness.
   *   · "whatever is enabled globally". Clearing it gives the rule its own list
   *     of sources, which is six checkboxes that exist only when that list does
   *     (FR-067). Without this, unchecking the box wrote the list to storage and
   *     revealed nothing, so per-rule scoping could not be reached from the
   *     editor at all — and re-checking it left the six behind, still live,
   *     editing a list no longer in the rule. Caught by review, because the
   *     harness did not touch this control; it does now.
   *
   * A boolean would not do here: the two rebuild the same body and want the
   * focus in different places, and the selector says which.
   */
  const update = (next: Rule, refocus?: string): void => {
    current = next;
    // Kept where a rebuild cannot destroy it. `current` lives in this closure,
    // and a structural edit replaces the closure along with the editor.
    if (editing?.id === next.id) editing = { ...editing, draft: next };
    const problems = validateRule(next);
    // Written only when valid. An invalid rule in storage is one the engine
    // meets during a fill, on a page the user is not looking at (UC-009 A1).
    if (problems.length === 0) commit(host, lens, replaceRule(lens.read(host.settings()), next));

    if (refocus !== undefined) {
      renderRules(host, list, lens);
      list.querySelector<HTMLElement>(`[data-rule="${next.id}"] ${refocus}`)?.focus();
      return;
    }
    rerenderBody(host, next, item, problems.length === 0);
  };

  body.append(
    field(message('ruleLabel'), textInput(rule.label, (value) => update({ ...live(), label: value })), message('ruleLabelHint')),
    checkbox(message('ruleEnabled'), rule.enabled, (value) => update({ ...live(), enabled: value })),
    matcher(live, update),
    sources(live, update),
    generatorFields(live, update),
    checkbox(message('ruleFromPersona'), rule.fromPersona, (value) => update({ ...live(), fromPersona: value }), message('ruleFromPersonaHint')),
    preview(rule, previewLocale(host)),
    problemList(validateRule(rule)),
  );
  return body;
}

function matcher(live: () => Rule, update: (rule: Rule) => void): HTMLElement {
  const rule = live();
  const mode = select(
    message('ruleMatchMode'),
    [
      ['contains', message('ruleModeContains')],
      ['exact', message('ruleModeExact')],
      ['regex', message('ruleModeRegex')],
    ],
    rule.match.mode,
    (value) =>
      update({ ...live(), match: { ...live().match, mode: value as Rule['match']['mode'] } }),
  );

  const pattern = field(
    message('ruleMatch'),
    textInput(rule.match.pattern, (value) =>
      update({ ...live(), match: { ...live().match, pattern: value } })),
    message('ruleMatchHint'),
  );

  const row = document.createElement('div');
  row.className = 'row';
  row.append(mode, pattern);
  return row;
}

/**
 * What each identity source is called, for a reader (NFR-018).
 *
 * `MatchSource` is spelled for the code that consumes it — `className`,
 * `ariaLabel` — and those spellings were what the six checkboxes displayed,
 * being passed straight in as labels. A settings screen that says "ariaLabel"
 * is showing an identifier to somebody who never wrote one, in the one control
 * FR-067 exists for, and it could not be translated because it was not a string.
 *
 * Declared as a total record rather than a lookup with a fallback, so adding a
 * seventh source is a compile error here instead of a raw identifier on screen.
 */
const SOURCE_LABELS: Record<MatchSource, MessageKey> = {
  name: 'sourceName',
  id: 'sourceId',
  className: 'sourceClassName',
  label: 'sourceLabel',
  placeholder: 'sourcePlaceholder',
  ariaLabel: 'sourceAriaLabel',
};

/**
 * The rule's own source scoping (FR-067).
 *
 * Presented as "whatever is enabled globally" plus a set of checkboxes, because
 * that is what the setting means: the effective sources are always the
 * intersection with the global toggles, and a rule cannot opt back into a source
 * switched off there.
 *
 * Unticking all six is allowed to happen and then refused: `validateRule` reports
 * it and `update` does not commit, which is the same path an empty pattern takes.
 * Preventing the last untick instead would leave the user with a checkbox that
 * silently does nothing and no statement of why.
 */
function sources(live: () => Rule, update: (rule: Rule, refocus?: string) => void): HTMLElement {
  const rule = live();
  const group = document.createElement('fieldset');
  group.className = 'sources';
  const legend = document.createElement('legend');
  legend.textContent = message('ruleSources');
  group.append(legend);

  const all = document.createElement('label');
  const allBox = document.createElement('input');
  allBox.type = 'checkbox';
  // Named so the rebuild below can put the focus back on it. Selecting the
  // fieldset's first input would work today and stop working the moment
  // anything is added above it.
  allBox.className = 'sources-all';
  allBox.checked = rule.sources === undefined;
  allBox.addEventListener('change', () => {
    // A spread drops the `readonly` modifiers, so the property can simply be
    // deleted. What was here cast twice — once to `{ sources?: unknown }` to
    // remove it and once back to the real type to assign it — and the `unknown`
    // arm meant the compiler stopped checking the one property this handler
    // exists to change.
    const next = { ...live() };
    delete next.sources;
    // Structural: this toggle is what decides whether the six per-source
    // checkboxes exist at all, so the body has to be rebuilt to show or remove
    // them. Focus returns here, to the box the user just operated.
    update(allBox.checked ? next : { ...next, sources: [...MATCH_SOURCES] }, '.sources-all');
  });
  all.append(allBox, document.createTextNode(` ${message('ruleSourcesAll')}`));
  group.append(all);

  if (rule.sources !== undefined) {
    for (const source of MATCH_SOURCES) {
      const chosen = rule.sources.includes(source);
      group.append(
        checkbox(message(SOURCE_LABELS[source]), chosen, (value) => {
          const kept = (live().sources ?? []).filter((candidate) => candidate !== source);
          update({ ...live(), sources: value ? [...kept, source] : kept });
        }),
      );
    }
  }
  return group;
}

/**
 * The generator types and their catalog keys, in the order they are offered.
 *
 * Keys rather than resolved strings, and a function below rather than a
 * module-level constant: resolving at import time makes loading this module
 * depend on `browser.i18n` already being live, which is a side effect a list of
 * pairs has no business having. It also meant nothing could import this file
 * without a catalog — the first unit test to try had to mock i18n before its
 * own import, for a constant it never used.
 */
const GENERATOR_TYPES: ReadonlyArray<readonly [Generator['type'], MessageKey]> = [
  ['name', 'genName'], ['email', 'genEmail'], ['username', 'genUsername'],
  ['organisation', 'genOrganisation'], ['telephone', 'genTelephone'], ['url', 'genUrl'],
  ['number', 'genNumber'], ['date', 'genDate'], ['text', 'genText'],
  ['alphanumeric', 'genAlphanumeric'], ['regex', 'genRegex'], ['list', 'genList'],
  ['constant', 'genConstant'],
];

function generatorOptions(): ReadonlyArray<readonly [string, string]> {
  return GENERATOR_TYPES.map(([type, key]) => [type, message(key)] as const);
}

function generatorFields(live: () => Rule, update: (rule: Rule, refocus?: string) => void): HTMLElement {
  const rule = live();
  const wrapper = document.createElement('div');
  wrapper.className = 'generator';

  wrapper.append(
    select(
      message('ruleGenerator'),
      generatorOptions(),
      rule.generator.type,
      // Keeps the name, matcher, scoping and flag; discards options that mean
      // nothing to the new type (UC-009 A4, ND-9). Structural: the fields the
      // new type needs are not the ones on screen.
      (value) => update(changeGeneratorType(live(), value as Generator['type']), '.generator select'),
    ),
  );

  /**
   * Applies one field of the generator, against the generator as it stands now.
   *
   * `live()` at both levels, and that is the whole point. Spreading the *rule*
   * from `live()` while spreading the *generator* from the object captured when
   * these fields were built is the shape that looks correct and is not: the
   * second edit to a multi-field generator is computed from the generator as it
   * was before the first, so setting `min` and then `max` writes `max` onto the
   * original and drops `min`.
   *
   * Nothing on screen says so, which is what makes it worth this much comment. A
   * non-structural edit does not re-render the fields, so the inputs keep showing
   * what was typed while storage holds something else — and the preview, which
   * does re-read `live()`, starts contradicting the values visible above it.
   * Only a reload reveals which of the two was real.
   *
   * The `type` argument is what keeps the patch checkable. It narrows the union
   * to the branch that asked, so naming a field belonging to a different
   * generator is a compile error rather than a property silently ignored.
   */
  const set =
    <T extends Generator['type']>(type: T) =>
    (patch: Partial<Extract<Generator, { type: T }>>): void => {
      const current = live().generator;
      // The type changed under us. Changing it is structural and re-renders
      // these fields, so this patch describes a generator no longer on screen.
      if (current.type !== type) return;
      // No cast: the guard above narrows `current` to the branch `patch` belongs
      // to, so the spread is already a `Generator` and the compiler knows it.
      update({ ...live(), generator: { ...current, ...patch } });
    };

  const generator = rule.generator;

  switch (generator.type) {
    case 'name':
      wrapper.append(select(message('genNamePart'), [
        ['full', message('genNameFull')], ['first', message('genNameFirst')], ['last', message('genNameLast')],
      ], generator.part, (value) => set('name')({ part: value as 'full' | 'first' | 'last' })));
      break;
    case 'number':
      wrapper.append(
        field(message('genMin'), numberInput(generator.min, (value) => set('number')({ min: value }), GENERATOR_BOUNDS.number)),
        field(message('genMax'), numberInput(generator.max, (value) => set('number')({ max: value }), GENERATOR_BOUNDS.number)),
        field(message('genDecimals'), numberInput(generator.decimals, (value) => set('number')({ decimals: value }), GENERATOR_BOUNDS.decimals)),
      );
      break;
    case 'date':
      wrapper.append(
        field(message('genFormat'), textInput(generator.format, (value) => set('date')({ format: value })), message('genFormatHint')),
        field(message('genFrom'), textInput(generator.from, (value) => set('date')({ from: value }))),
        field(message('genTo'), textInput(generator.to, (value) => set('date')({ to: value }))),
      );
      break;
    case 'text':
      wrapper.append(
        field(message('genMinWords'), numberInput(generator.minWords, (value) => set('text')({ minWords: value }), GENERATOR_BOUNDS.words)),
        field(message('genMaxWords'), numberInput(generator.maxWords, (value) => set('text')({ maxWords: value }), GENERATOR_BOUNDS.words)),
      );
      break;
    case 'alphanumeric':
      wrapper.append(field(message('genTemplate'), textInput(generator.template, (value) => set('alphanumeric')({ template: value })), message('genTemplateHint')));
      break;
    case 'regex':
      wrapper.append(field(message('genPattern'), textInput(generator.pattern, (value) => set('regex')({ pattern: value })), message('genPatternHint')));
      break;
    case 'list':
      wrapper.append(field(message('genItems'), textArea(generator.items.join('\n'), (value) =>
        set('list')({ items: value.split('\n').map((item) => item.trim()).filter((item) => item !== '') })),
        message('genItemsHint')));
      break;
    case 'constant':
      wrapper.append(field(message('genValue'), textInput(generator.value, (value) => set('constant')({ value }))));
      break;
    default:
      // The persona-backed types carry no options of their own.
      break;
  }
  return wrapper;
}

/** UC-013. Several samples, from the real generators, replaced on every change. */
function preview(rule: Rule, locale: Locale): HTMLElement {
  const box = document.createElement('div');
  box.className = 'preview';

  const heading = document.createElement('h4');
  heading.textContent = message('rulePreview');
  box.append(heading);

  const sample = sampleRule(rule, locale, Math.floor(Math.random() * 2 ** 31));

  if (!sample.ok) {
    const note = document.createElement('p');
    note.className = 'muted';
    // No stale samples: output that no longer belongs to what is on screen is
    // worse than none (UC-013 A1).
    note.textContent =
      'unusable' in sample ? message('rulePreviewUnusable') : message('rulePreviewEmpty');
    box.append(note);
    return box;
  }

  const list = document.createElement('ul');
  list.className = 'samples';
  for (const value of sample.values) {
    const item = document.createElement('li');
    // `textContent`: a sample is generated, but a constant is whatever the user
    // typed, and this page must never turn typed text into markup.
    item.textContent = value;
    list.append(item);
  }
  box.append(list);
  return box;
}

function problemList(problems: ReturnType<typeof validateRule>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'problems';
  box.setAttribute('role', 'alert');
  for (const problem of problems) {
    const line = document.createElement('p');
    line.className = 'problem';
    line.textContent = message('ruleInvalid', [problemText(problem)]);
    box.append(line);
  }
  return box;
}

/**
 * One validation failure as a sentence (NFR-018, NFR-020).
 *
 * `problem.code` goes straight into `message`, whose parameter type is the union
 * of keys WXT generates from the catalog — so a code without a message does not
 * compile, and the pairing needs no test to hold. What used to be here was
 * `message('ruleInvalid', [problem.message])`, where `problem.message` was an
 * English literal from `lib/rules/validate.ts`: the frame was translatable and
 * the sentence inside it never could be.
 */
function problemText(problem: RuleProblem): string {
  return problem.params === undefined
    ? message(problem.code)
    : message(problem.code, problem.params);
}

/* ------------------------------------------------------------ small builders */

/**
 * Which corpus the preview draws from.
 *
 * `auto` resolves against the browser's UI language in the background, which
 * this page cannot see without asking. It previews as en-US instead — and that
 * is honest rather than approximate, because the samples exist to show the
 * *shape* of a rule's output, and a rule's shape does not depend on the corpus
 * behind a persona-backed slot.
 */
function previewLocale(host: RuleEditorHost): Locale {
  const { locale } = host.settings();
  return locale === 'auto' ? 'en-US' : locale;
}

function nameOf(rule: Rule): string {
  // Falls back to the pattern rather than to nothing: worse to read, never
  // blank, and blank is what makes a report unusable (BR-009-3).
  return rule.label !== '' ? rule.label : rule.match.pattern !== '' ? rule.match.pattern : message('ruleUnnamed');
}

function commit(host: RuleEditorHost, lens: RuleLens, rules: readonly Rule[]): void {
  host.save(lens.write(host.settings(), rules));
}

/**
 * Re-renders only the preview and the problems, not the whole editor.
 *
 * Rebuilding the form on every keystroke would take the focus and the caret with
 * it, which makes a text field unusable. The two parts that must follow the
 * rule are replaced in place instead.
 */
function rerenderBody(host: RuleEditorHost, rule: Rule, item: HTMLElement, valid: boolean): void {
  const body = item.querySelector('.rule-body');
  if (body === null) return;

  body.querySelector('.preview')?.replaceWith(preview(rule, previewLocale(host)));
  body.querySelector('.problems')?.replaceWith(problemList(validateRule(rule)));

  const name = item.querySelector('.rule-name');
  if (name instanceof HTMLElement) name.firstChild!.textContent = nameOf(rule);

  const flag = item.querySelector('.rule-flag');
  if (valid) flag?.remove();
}
