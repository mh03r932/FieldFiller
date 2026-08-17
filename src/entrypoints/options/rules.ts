import { message } from '@/lib/platform/i18n';
import { MATCH_SOURCES, type Generator, type MatchSource, type Rule, type Settings } from '@/lib/settings';
import {
  addRule,
  changeGeneratorType,
  moveRule,
  removeRule,
  replaceRule,
  restoreRule,
  sampleRule,
} from '@/lib/rules/editing';
import { validateRule } from '@/lib/rules/validate';
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

export type RuleEditorHost = {
  readonly settings: () => Settings;
  /** Persists a whole settings state. Rejects are surfaced by the caller. */
  readonly save: (settings: Settings) => void;
  /** Announced politely, for changes a sighted user sees and nobody else would. */
  readonly announce: (text: string) => void;
};

/** Which rule is expanded. One at a time: the list is the context (UC-009). */
let openRuleId: string | undefined;

/** The last deletion, for as long as this page stays open (UC-011). */
let undoable: { readonly rule: Rule; readonly at: number } | undefined;

export function renderRules(host: RuleEditorHost, into: HTMLElement): void {
  const rules = host.settings().rules;
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
      list.append(ruleRow(host, rule, index, rules.length));
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
    commit(host, addRule(host.settings().rules, id));
    openRuleId = id;
    renderRules(host, into);
    into.querySelector<HTMLInputElement>(`[data-rule="${id}"] input`)?.focus();
  });
  into.append(add);

  if (undoable !== undefined) into.append(undoOffer(host, into));
}

function undoOffer(host: RuleEditorHost, into: HTMLElement): HTMLElement {
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
    // Back to the position it held, not to the end: order is meaning, and the
    // user asked to undo rather than to re-add (BR-011-2).
    commit(host, restoreRule(host.settings().rules, removed.rule, removed.at));
    undoable = undefined;
    renderRules(host, into);
  });

  bar.append(text, undo);
  return bar;
}

function ruleRow(host: RuleEditorHost, rule: Rule, index: number, total: number): HTMLElement {
  const item = document.createElement('li');
  item.className = 'rule';
  item.dataset['rule'] = rule.id;

  const header = document.createElement('div');
  header.className = 'rule-header';

  const disclose = document.createElement('button');
  disclose.type = 'button';
  disclose.className = 'rule-name';
  disclose.setAttribute('aria-expanded', String(openRuleId === rule.id));
  disclose.textContent = nameOf(rule);
  disclose.addEventListener('click', () => {
    openRuleId = openRuleId === rule.id ? undefined : rule.id;
    rerender(host, item);
  });

  const problems = validateRule(rule);
  if (problems.length > 0) {
    const flag = document.createElement('span');
    flag.className = 'rule-flag';
    flag.textContent = '!';
    flag.title = problems[0]!.message;
    disclose.append(flag);
  }

  header.append(disclose, ordering(host, rule, index, total, item), remove(host, rule, index, item));
  item.append(header);

  if (openRuleId === rule.id) item.append(editor(host, rule, item));
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
  item: HTMLElement,
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
    // A visible label would repeat for every rule; the accessible name carries
    // it instead, and the title makes it discoverable with a pointer.
    button.setAttribute('aria-label', `${message(key)}: ${nameOf(rule)}`);
    button.title = message(key);
    // Unavailable rather than inert, so the limit is visible before it is
    // reached (UC-012 A1).
    button.disabled = disabled;
    button.addEventListener('click', () => {
      const moved = moveRule(host.settings().rules, rule.id, direction);
      commit(host, moved);
      const position = moved.findIndex((candidate) => candidate.id === rule.id) + 1;
      host.announce(message('ruleMoved', [nameOf(rule), String(position), String(moved.length)]));
      const list = item.closest('#rules');
      if (list instanceof HTMLElement) {
        renderRules(host, list);
        list
          .querySelector<HTMLButtonElement>(`[data-rule="${rule.id}"] .rule-order button:not(:disabled)`)
          ?.focus();
      }
    });
    group.append(button);
  }
  return group;
}

function remove(host: RuleEditorHost, rule: Rule, index: number, item: HTMLElement): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rule-delete';
  button.textContent = message('ruleDelete');
  button.setAttribute('aria-label', `${message('ruleDelete')}: ${nameOf(rule)}`);
  button.addEventListener('click', () => {
    // Immediate and reversible rather than confirmed and permanent: a
    // confirmation taxes every user to protect the one who misclicked
    // (BR-011-1).
    undoable = { rule, at: index };
    commit(host, removeRule(host.settings().rules, rule.id));
    if (openRuleId === rule.id) openRuleId = undefined;
    const list = item.closest('#rules');
    if (list instanceof HTMLElement) renderRules(host, list);
  });
  return button;
}

function editor(host: RuleEditorHost, rule: Rule, item: HTMLElement): HTMLElement {
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
   * `structural` means the *set* of fields changed, not just their values.
   *
   * Ordinary edits re-render only the preview and the problems, because
   * rebuilding the form on every keystroke would take the focus and the caret
   * with it and make a text field unusable. A change of generator type is the
   * one edit that genuinely changes which fields exist — a date has a format
   * where a regex has a pattern — so it rebuilds the body and puts the focus
   * back on the control that caused it.
   *
   * Found by the options-page harness: without this the new type's fields never
   * appeared, and the rule kept the previous type's editor while storing the
   * new type's defaults.
   */
  const update = (next: Rule, structural = false): void => {
    current = next;
    const problems = validateRule(next);
    // Written only when valid. An invalid rule in storage is one the engine
    // meets during a fill, on a page the user is not looking at (UC-009 A1).
    if (problems.length === 0) commit(host, replaceRule(host.settings().rules, next));

    if (structural) {
      const list = item.closest('#rules');
      if (list instanceof HTMLElement) {
        renderRules(host, list);
        list.querySelector<HTMLSelectElement>(`[data-rule="${next.id}"] .generator select`)?.focus();
      }
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
 * The rule's own source scoping (FR-067).
 *
 * Presented as "whatever is enabled globally" plus a set of checkboxes, because
 * that is what the setting means: the effective sources are always the
 * intersection with the global toggles, and a rule cannot opt back into a source
 * switched off there.
 */
function sources(live: () => Rule, update: (rule: Rule) => void): HTMLElement {
  const rule = live();
  const group = document.createElement('fieldset');
  group.className = 'sources';
  const legend = document.createElement('legend');
  legend.textContent = message('ruleSources');
  group.append(legend);

  const all = document.createElement('label');
  const allBox = document.createElement('input');
  allBox.type = 'checkbox';
  allBox.checked = rule.sources === undefined;
  allBox.addEventListener('change', () => {
    const next = { ...live() };
    if (allBox.checked) delete (next as { sources?: unknown }).sources;
    else (next as { sources?: readonly MatchSource[] }).sources = [...MATCH_SOURCES];
    update(next);
  });
  all.append(allBox, document.createTextNode(` ${message('ruleSourcesAll')}`));
  group.append(all);

  if (rule.sources !== undefined) {
    for (const source of MATCH_SOURCES) {
      const chosen = rule.sources.includes(source);
      group.append(
        checkbox(source, chosen, (value) => {
          const kept = (live().sources ?? []).filter((candidate) => candidate !== source);
          update({ ...live(), sources: value ? [...kept, source] : kept });
        }),
      );
    }
  }
  return group;
}

const GENERATOR_LABELS: ReadonlyArray<readonly [Generator['type'], string]> = [
  ['name', 'genName'], ['email', 'genEmail'], ['username', 'genUsername'],
  ['organisation', 'genOrganisation'], ['telephone', 'genTelephone'], ['url', 'genUrl'],
  ['number', 'genNumber'], ['date', 'genDate'], ['text', 'genText'],
  ['alphanumeric', 'genAlphanumeric'], ['regex', 'genRegex'], ['list', 'genList'],
  ['constant', 'genConstant'],
].map(([type, key]) => [type as Generator['type'], message(key as 'genName')] as const);

function generatorFields(live: () => Rule, update: (rule: Rule, structural?: boolean) => void): HTMLElement {
  const rule = live();
  const wrapper = document.createElement('div');
  wrapper.className = 'generator';

  wrapper.append(
    select(
      message('ruleGenerator'),
      GENERATOR_LABELS.map(([type, label]) => [type, label] as const),
      rule.generator.type,
      // Keeps the name, matcher, scoping and flag; discards options that mean
      // nothing to the new type (UC-009 A4, ND-9). Structural: the fields the
      // new type needs are not the ones on screen.
      (value) => update(changeGeneratorType(live(), value as Generator['type']), true),
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
        field(message('genMin'), numberInput(generator.min, (value) => set('number')({ min: value }))),
        field(message('genMax'), numberInput(generator.max, (value) => set('number')({ max: value }))),
        field(message('genDecimals'), numberInput(generator.decimals, (value) => set('number')({ decimals: value }))),
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
        field(message('genMinWords'), numberInput(generator.minWords, (value) => set('text')({ minWords: value }))),
        field(message('genMaxWords'), numberInput(generator.maxWords, (value) => set('text')({ maxWords: value }))),
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
    line.textContent = message('ruleInvalid', [problem.message]);
    box.append(line);
  }
  return box;
}

/* ------------------------------------------------------------ small builders */

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
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

function textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.addEventListener('input', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return input;
}

function textArea(value: string, onChange: (value: string) => void): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.rows = 4;
  area.value = value;
  area.addEventListener('input', () => onChange(area.value));
  return area;
}

function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void, hint?: string): HTMLElement {
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

function select(
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
  chosen: string,
  onChange: (value: string) => void,
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
  return field(label, control);
}

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

function commit(host: RuleEditorHost, rules: readonly Rule[]): void {
  host.save({ ...host.settings(), rules });
}

function rerender(host: RuleEditorHost, item: HTMLElement): void {
  const list = item.closest('#rules');
  if (list instanceof HTMLElement) renderRules(host, list);
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
