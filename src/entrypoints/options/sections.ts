import { message, type MessageKey } from '@/lib/platform/i18n';
import {
  MATCH_SOURCES,
  PASSWORD_LENGTH,
  type Behaviour,
  type Matcher,
  type MatchSource,
  type Settings,
} from '@/lib/settings';
import { LOCALES } from '@/lib/persona/corpus/corpus';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { appendAt, newExclusion, removeAt, replaceAt } from '@/lib/exclusions';
import { validateDomainPattern, validateMatcher } from '@/lib/rules/validate';
import type { ControlKind } from '@/lib/protocol';
import {
  checkbox,
  field,
  focusIn,
  numberInput,
  optionalNumberInput,
  select,
  textArea,
  textInput,
} from './controls';
import type { OptionsHost } from './host';
import { renderProfiles } from './profiles-section';

/**
 * Every options section that is not the rule editor: UC-018..UC-023, plus the
 * control for the corpus locale.
 *
 * One module rather than six files, because they are the same shape six times —
 * read a slice of settings, draw controls over it, write the whole state back —
 * and the differences worth reading are in what each *means*, not in how each is
 * assembled. The rule editor is separate because it is genuinely different: it
 * has an open-item, a draft, an undo and a preview, and none of that is here.
 *
 * Saving is per change and never staged, the same as the rule editor
 * (BR-009-1). There is no Save button on this page at all, so there is no state
 * in which what the user sees and what a fill would do disagree — which is what
 * UC-024's postcondition actually asks for.
 *
 * Every user-facing string comes from the catalog (NFR-018), and every value the
 * user typed is written with `textContent`. A pattern is text; it must never be
 * able to become an element.
 */

/* ------------------------------------------------------------------- general */

/**
 * The corpus locale (ND-1).
 *
 * `auto` is offered first and is the default, because following the browser's UI
 * language is right for most people and is the only answer available without
 * asking. The explicit entries are what a Swiss developer with an English
 * browser needs, and the hint says which way `auto` would resolve rather than
 * leaving them to test it — resolution happens in the background against
 * `getUILanguage`, which this page can read for display but does not decide.
 */
export function renderGeneral(host: OptionsHost, into: HTMLElement): void {
  const settings = host.settings();
  into.replaceChildren(
    select(
      message('localeLabel'),
      [['auto', message('localeAuto')], ...LOCALES.map((locale) => [locale, locale] as const)],
      settings.locale,
      (value) => {
        // `host.settings()`, not the `settings` read above — see `renderSources`
        // for the same hazard at closer range. It is worse here: one control
        // means nothing ever re-renders this section from its own handler, so
        // its snapshot is as old as the page (or as the last write from another
        // tab). Saving the whole state from it would revert every change made in
        // every other section since, in memory and in storage alike.
        host.save({ ...host.settings(), locale: value as Settings['locale'] });
        host.announce(message('localeChanged', [value]));
      },
      message('localeHint'),
    ),
  );
}

/* ------------------------------------------------------------------- sources */

/**
 * What each identity source is called, for a reader (NFR-018).
 *
 * The same table the rule editor uses, and deliberately the same strings: a
 * source called "CSS class" in one section and `className` in another reads as
 * two different settings. Declared as a total record so a seventh source is a
 * compile error here rather than a raw identifier on screen.
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
 * The global matching sources (UC-018, FR-028).
 *
 * These are a *bound*, not a suggestion: a rule naming a source switched off
 * here matches nothing through it, because the effective set is always the
 * intersection (FR-067). The hint says so in those words, since a rule that
 * lists `className` and quietly never fires is otherwise indistinguishable from
 * a rule with a bad pattern.
 *
 * `className` ships off. It is the noisiest source by a distance — a
 * utility-first stylesheet puts twenty meaningless tokens in it — and the other
 * half of real markup names its fields there and nowhere else, which is why it
 * is offered at all rather than dropped.
 *
 * Turning all six off is allowed. It leaves every rule inert and the built-in
 * generator untouched, which is a legible state rather than a broken one: rules
 * off, everything else as it was. The count beneath the boxes is what makes it
 * visible instead of something the user infers from rules that stopped working.
 */
export function renderSources(host: OptionsHost, into: HTMLElement): void {
  const settings = host.settings();

  const group = document.createElement('fieldset');
  group.className = 'sources';
  const legend = document.createElement('legend');
  legend.textContent = message('sourcesLegend');
  group.append(legend);

  for (const source of MATCH_SOURCES) {
    const label = message(SOURCE_LABELS[source]);
    const box = checkbox(label, settings.sources[source], (value) => {
      // `host.settings()`, not the `settings` captured above: six checkboxes
      // sharing one snapshot means the second tick is computed from the state
      // before the first, so ticking two in a row loses the first — the stale
      // closure the rule editor was fixed for, which is easy to reintroduce
      // exactly here because nothing re-renders between the two clicks.
      const current = host.settings();
      host.save({ ...current, sources: { ...current.sources, [source]: value } });
      host.announce(message(value ? 'sourceEnabled' : 'sourceDisabled', [label]));
      countSources(host, into);
    });
    box.dataset['source'] = source;
    group.append(box);
  }

  into.replaceChildren(group, sourceCount(host));
}

function sourceCount(host: OptionsHost): HTMLElement {
  const line = document.createElement('p');
  line.className = 'muted source-count';
  const enabled = MATCH_SOURCES.filter((source) => host.settings().sources[source]).length;
  line.textContent =
    enabled === 0
      ? message('sourcesNoneEnabled')
      : message('sourcesEnabledCount', [String(enabled), String(MATCH_SOURCES.length)]);
  return line;
}

/** Replaces the count in place, so ticking a box does not move the focus. */
function countSources(host: OptionsHost, into: HTMLElement): void {
  into.querySelector('.source-count')?.replaceWith(sourceCount(host));
}

/* ---------------------------------------------------------- field exclusions */

/**
 * Fields never to fill, and the two structural skips beside them (UC-020).
 *
 * The list carries the same three match modes rules do (DD-005), which is why it
 * is drawn with the same two controls: a mode and a pattern. A pre-DD-005 stored
 * entry was a regular expression and is lifted as one, so what is on screen is
 * what was meant — reading those as literals would silently change every
 * exclusion an early user wrote.
 *
 * `skipHidden` and `skipPreFilled` live here rather than under behaviour because
 * they answer the same question the list does — which controls are left alone —
 * and a user looking for "don't touch this field" should find all three in one
 * place (UC-020 covers FR-034..FR-036 together for the same reason).
 */
export function renderFieldExclusions(host: OptionsHost, into: HTMLElement): void {
  const settings = host.settings();
  const { fields } = settings.exclusions;

  const list = document.createElement('ol');
  list.className = 'exclusion-list';
  for (const [index, matcher] of fields.entries()) {
    list.append(fieldExclusionRow(host, into, matcher, index));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary';
  add.textContent = message('exclusionAdd');
  add.addEventListener('click', () => {
    const current = host.settings();
    saveFields(host, appendAt(current.exclusions.fields, newExclusion()));
    renderFieldExclusions(host, into);
    // Onto the pattern box of the row that just appeared. A blank row with the
    // focus left on `<body>` is a row the user has to go and find.
    focusIn(into, `[data-exclusion="${String(current.exclusions.fields.length)}"] input[type="text"]`);
  });

  into.replaceChildren(
    fields.length === 0 ? emptyNote('exclusionsEmpty') : list,
    add,
    checkbox(
      message('behaviourSkipHidden'),
      settings.behaviour.skipHidden,
      (value) => saveBehaviour(host, { skipHidden: value }),
      message('behaviourSkipHiddenHint'),
    ),
    checkbox(
      message('behaviourSkipPreFilled'),
      settings.behaviour.skipPreFilled,
      (value) => saveBehaviour(host, { skipPreFilled: value }),
      message('behaviourSkipPreFilledHint'),
    ),
  );
}

function fieldExclusionRow(
  host: OptionsHost,
  into: HTMLElement,
  matcher: Matcher,
  index: number,
): HTMLElement {
  const row = document.createElement('li');
  row.className = 'exclusion';
  row.dataset['exclusion'] = String(index);

  // The matcher as it is *now*. Every handler below reads through this, so the
  // second edit to a row is applied to the result of the first: choosing a mode
  // and then typing a pattern must not discard the mode (the rule editor's
  // `live()`, at one row's scale).
  const live = (): Matcher => host.settings().exclusions.fields[index] ?? matcher;

  const update = (next: Matcher): void => {
    saveFields(host, replaceAt(host.settings().exclusions.fields, index, next));
    // Only the problem line, never the fields: rebuilding them on every
    // keystroke takes the caret with it.
    row.querySelector('.problems')?.replaceWith(matcherProblems(next));
  };

  const mode = select(
    message('ruleMatchMode'),
    [
      ['contains', message('ruleModeContains')],
      ['exact', message('ruleModeExact')],
      ['regex', message('ruleModeRegex')],
    ],
    matcher.mode,
    (value) => update({ ...live(), mode: value as Matcher['mode'] }),
  );

  const pattern = field(
    message('exclusionPattern'),
    textInput(matcher.pattern, (value) => update({ ...live(), pattern: value })),
    message('exclusionPatternHint'),
  );

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'exclusion-delete';
  remove.textContent = message('exclusionRemove');
  // The pattern, not the position: "remove exclusion 3" tells a screen-reader
  // user nothing about what they are removing.
  remove.setAttribute(
    'aria-label',
    `${message('exclusionRemove')}: ${matcher.pattern === '' ? message('exclusionUnnamed') : matcher.pattern}`,
  );
  remove.addEventListener('click', () => {
    saveFields(host, removeAt(host.settings().exclusions.fields, index));
    host.announce(message('exclusionRemoved'));
    renderFieldExclusions(host, into);
    // Onto the next row's remove button, or the add button when the list ran
    // out — never nowhere, which for a keyboard user means starting again from
    // the top of the page after every removal.
    if (!focusIn(into, `[data-exclusion="${String(index)}"] .exclusion-delete`)) {
      focusIn(into, 'button.primary');
    }
  });

  const controls = document.createElement('div');
  controls.className = 'row';
  controls.append(mode, pattern, remove);
  row.append(controls, matcherProblems(matcher));
  return row;
}

/**
 * What is wrong with a matcher, beside the field that caused it (FR-070).
 *
 * Shown rather than enforced. The entry is stored either way, which differs from
 * a rule and is deliberate: a rule that will not compile is met by the engine
 * during a fill on a page the user is not looking at, whereas an exclusion that
 * will not compile is *skipped* by the agent with the rest of the list intact
 * (UC-005 A5). Refusing to store it would lose the half-typed pattern on every
 * keystroke that made it briefly invalid.
 */
function matcherProblems(matcher: Matcher): HTMLElement {
  const box = document.createElement('div');
  box.className = 'problems';
  box.setAttribute('role', 'alert');
  for (const problem of validateMatcher(matcher)) {
    const line = document.createElement('p');
    line.className = 'problem';
    line.textContent =
      problem.params === undefined
        ? message(problem.code)
        : message(problem.code, problem.params);
    box.append(line);
  }
  return box;
}

/* --------------------------------------------------------- domain exclusions */

/**
 * Domains where the extension stays inert (UC-021, FR-037, FR-074).
 *
 * Loaded but never asked to act, which is what BR-008-4 settled: the alternative
 * — not injecting at all — needs runtime content-script registration, and that
 * is state which fails silently in the direction that matters. So an excluded
 * page has an agent on it that is never spoken to, and the badge says the tab is
 * excluded rather than the fill quietly doing nothing.
 *
 * Globs rather than regular expressions, in the vocabulary of extension match
 * patterns: `*` is any run of characters, everything else is literal, and the
 * port takes no part. That is not a simplification for the user's benefit — this
 * check runs before every fill, and a second catastrophic-backtracking surface
 * there is where NFR-009 is hardest to guarantee.
 */
export function renderDomainExclusions(host: OptionsHost, into: HTMLElement): void {
  const domains = host.settings().exclusions.domains;

  const list = document.createElement('ol');
  list.className = 'exclusion-list';
  for (const [index, pattern] of domains.entries()) {
    list.append(domainRow(host, into, pattern, index));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary';
  add.textContent = message('domainAdd');
  add.addEventListener('click', () => {
    const current = host.settings().exclusions.domains;
    saveDomains(host, appendAt(current, ''));
    renderDomainExclusions(host, into);
    focusIn(into, `[data-domain="${String(current.length)}"] input[type="text"]`);
  });

  into.replaceChildren(domains.length === 0 ? emptyNote('domainsEmpty') : list, add);
}

function domainRow(
  host: OptionsHost,
  into: HTMLElement,
  pattern: string,
  index: number,
): HTMLElement {
  const row = document.createElement('li');
  row.className = 'exclusion';
  row.dataset['domain'] = String(index);

  const update = (value: string): void => {
    saveDomains(host, replaceAt(host.settings().exclusions.domains, index, value));
    row.querySelector('.problems')?.replaceWith(domainProblem(value));
  };

  const input = field(
    message('domainPattern'),
    textInput(pattern, update),
    message('domainPatternHint'),
  );

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'exclusion-delete';
  remove.textContent = message('exclusionRemove');
  remove.setAttribute(
    'aria-label',
    `${message('exclusionRemove')}: ${pattern === '' ? message('exclusionUnnamed') : pattern}`,
  );
  remove.addEventListener('click', () => {
    saveDomains(host, removeAt(host.settings().exclusions.domains, index));
    host.announce(message('domainRemoved'));
    renderDomainExclusions(host, into);
    if (!focusIn(into, `[data-domain="${String(index)}"] .exclusion-delete`)) {
      focusIn(into, 'button.primary');
    }
  });

  const controls = document.createElement('div');
  controls.className = 'row';
  controls.append(input, remove);
  row.append(controls, domainProblem(pattern));
  return row;
}

function domainProblem(pattern: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'problems';
  box.setAttribute('role', 'alert');

  const problem = validateDomainPattern(pattern);
  if (problem !== undefined) {
    const line = document.createElement('p');
    line.className = 'problem';
    line.textContent = message(problem);
    box.append(line);
  }
  return box;
}

/* ----------------------------------------------------------------- behaviour */

/**
 * The control kinds a length cap is offered for (UC-022, FR-065).
 *
 * The free-text kinds, and only those. A cap on `email` or `url` would produce a
 * value the page's own type validation rejects — a truncated address is not a
 * shorter address, it is a broken one — so offering it would be offering a way
 * to make fills fail. `textarea` is the kind the setting exists for: ND-10's
 * papercut is the reference giving an unconstrained textarea twenty characters,
 * and this is where a user says what it should get instead.
 */
const CAPPED_KINDS: ReadonlyArray<readonly [ControlKind, MessageKey]> = [
  ['text', 'kindText'],
  ['search', 'kindSearch'],
  ['textarea', 'kindTextarea'],
  ['contenteditable', 'kindContenteditable'],
];

/**
 * Fill behaviour defaults (UC-022, FR-014, FR-015, FR-024, FR-049).
 *
 * Three unrelated-looking things, together because they are the settings that
 * change what a fill *does* to a control it has decided to fill, as opposed to
 * which controls it picks.
 */
export function renderBehaviour(host: OptionsHost, into: HTMLElement): void {
  const { behaviour } = host.settings();

  const lengths = document.createElement('fieldset');
  lengths.className = 'group';
  const legend = document.createElement('legend');
  legend.textContent = message('behaviourLengthsLegend');
  lengths.append(legend);
  for (const [kind, key] of CAPPED_KINDS) {
    lengths.append(
      field(
        message(key),
        optionalNumberInput(behaviour.maxLengths[kind], (value) => {
          const caps = { ...host.settings().behaviour.maxLengths };
          // Deleted rather than set to `undefined`: the two are the same to a
          // reader and different to `JSON.stringify`, and this object is
          // compared as JSON by the page's own storage listener to decide
          // whether a write was somebody else's.
          if (value === undefined) delete caps[kind];
          else caps[kind] = value;
          saveBehaviour(host, { maxLengths: caps });
        }),
        message('behaviourLengthHint'),
      ),
    );
  }

  into.replaceChildren(
    checkbox(
      message('behaviourDispatchEvents'),
      behaviour.dispatchEvents,
      (value) => saveBehaviour(host, { dispatchEvents: value }),
      message('behaviourDispatchEventsHint'),
    ),
    lengths,
    field(
      message('behaviourConsentKeywords'),
      textArea(behaviour.consentKeywords.join('\n'), (value) =>
        saveBehaviour(host, { consentKeywords: lines(value) })),
      message('behaviourConsentKeywordsHint'),
    ),
    field(
      message('behaviourConfirmationKeywords'),
      textArea(behaviour.confirmationKeywords.join('\n'), (value) =>
        saveBehaviour(host, { confirmationKeywords: lines(value) })),
      message('behaviourConfirmationKeywordsHint'),
    ),
  );
}

/**
 * One keyword per line, trimmed, blanks dropped.
 *
 * The blank drop is not tidiness. A keyword of `''` is a substring of every
 * identity, so one stray empty line would tick every checkbox on every page —
 * and an empty line is the one edit that looks like nothing at all on screen.
 * `parseSettings` does this again on the way into storage, because this page is
 * not the only writer it has to survive.
 */
function lines(value: string): readonly string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/* ----------------------------------------------------------------- passwords */

/**
 * The password policy (UC-019, FR-025).
 *
 * Whatever this produces is still fitted to the field's own `pattern`,
 * `minlength` and `maxlength` before it is written (FR-072), and the hint says
 * so: a user who sets a 32-character policy and watches a field receive 12 is
 * otherwise looking at a bug. Policy loses to the page, always.
 *
 * The sample beneath is UC-013's argument applied here — a policy is four
 * checkboxes and a number, and what it *produces* is the thing being configured.
 * It is drawn from the same generator a fill uses, so it cannot drift into
 * showing something the engine would not make.
 */
export function renderPasswords(host: OptionsHost, into: HTMLElement): void {
  const policy = host.settings().passwords;

  const update = (patch: Partial<Settings['passwords']>): void => {
    const current = host.settings();
    host.save({ ...current, passwords: { ...current.passwords, ...patch } });
    into.querySelector('.preview')?.replaceWith(passwordSample(host));
  };

  const classes = document.createElement('fieldset');
  classes.className = 'group';
  const legend = document.createElement('legend');
  legend.textContent = message('passwordClassesLegend');
  classes.append(legend);
  for (const [name, key] of [
    ['upper', 'passwordUpper'],
    ['lower', 'passwordLower'],
    ['digits', 'passwordDigits'],
    ['symbols', 'passwordSymbols'],
  ] as const) {
    classes.append(checkbox(message(key), policy[name], (value) => update({ [name]: value })));
  }

  into.replaceChildren(
    field(
      message('passwordLength'),
      numberInput(policy.length, (value) => update({ length: value }), PASSWORD_LENGTH),
      message('passwordLengthHint'),
    ),
    classes,
    passwordSample(host),
  );
}

/**
 * A sample from the policy as it stands.
 *
 * One rather than four, unlike a rule's preview: a password has no variability
 * worth showing beyond its shape, and four of them read as a list of secrets.
 *
 * The unticked-everything case is stated in words rather than shown silently
 * satisfied. The generator falls back to lowercase there — a password drawn from
 * no character class is the empty string — and a sample that simply looked
 * lowercase would leave the user to work out why (UC-019 A1).
 */
function passwordSample(host: OptionsHost): HTMLElement {
  const box = document.createElement('div');
  box.className = 'preview';

  const heading = document.createElement('h4');
  heading.textContent = message('passwordSample');
  box.append(heading);

  const settings = host.settings();
  const { upper, lower, digits, symbols } = settings.passwords;
  if (!upper && !lower && !digits && !symbols) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = message('passwordNoClasses');
    box.append(note);
  }

  const sample = document.createElement('p');
  sample.className = 'samples';
  // A fresh seed per render, so the sample changes as the policy does rather
  // than looking frozen. The locale is irrelevant to a password and is passed
  // only because the persona needs one.
  const random = seededRandom(Math.floor(Math.random() * 2 ** 31));
  sample.textContent = createPersona(random, 'en-US', settings.passwords).password;
  box.append(sample);
  return box;
}

/* ------------------------------------------------------------------ triggers */

/**
 * Where the browser's own keyboard shortcut settings live.
 *
 * Per target because the two browsers have nothing in common here. Neither
 * address is one an extension may navigate to on the user's behalf in every
 * case, which is exactly why it is presented as an address to go to rather than
 * as a button that claims to take you there (BR-023-1).
 */
const SHORTCUT_ADDRESS =
  import.meta.env.BROWSER === 'firefox' ? 'about:addons' : 'chrome://extensions/shortcuts';

/**
 * Which ways of invoking a fill are available (UC-023, FR-050).
 *
 * All three are listed, and only one carries a control. That asymmetry is the
 * section's content rather than an omission:
 *
 *   · the **toolbar button** is the zero-configuration path and cannot be turned
 *     off (BR-023-2). A user who never opens this page still reaches the main
 *     action in one click, and removing that route from a screen they may not
 *     find their way back to is not a setting worth having.
 *   · the **keyboard** cannot be configured by any extension — only the browser
 *     assigns bindings. So this offers the address of the browser's own page and
 *     says that is what it is. A control that looked like it rebound a key and
 *     merely opened a page would be a lie the user discovers only when their new
 *     binding does not work (BR-023-1).
 *   · the **context menu** is the one real setting, and turning it off leaves the
 *     other two untouched (BR-023-3).
 */
export function renderTriggers(host: OptionsHost, into: HTMLElement): void {
  const { triggers } = host.settings();

  const toolbar = document.createElement('p');
  toolbar.className = 'muted';
  toolbar.textContent = message('triggerToolbarAlways');

  const shortcuts = document.createElement('p');
  shortcuts.className = 'muted';
  shortcuts.textContent = message('triggerShortcutsRoute', [SHORTCUT_ADDRESS]);

  into.replaceChildren(
    toolbar,
    checkbox(
      message('triggerContextMenu'),
      triggers.contextMenu,
      (value) => {
        host.save({ ...host.settings(), triggers: { contextMenu: value } });
        host.announce(message(value ? 'triggerContextMenuOn' : 'triggerContextMenuOff'));
      },
      message('triggerContextMenuHint'),
    ),
    shortcuts,
  );
}

/* ------------------------------------------------------------------- helpers */

function emptyNote(key: MessageKey): HTMLElement {
  const note = document.createElement('p');
  note.className = 'muted';
  // Not "you have nothing configured" — an empty exclusion list is a working
  // configuration, and saying so is the difference between an empty state and a
  // broken-looking one.
  note.textContent = message(key);
  return note;
}

function saveBehaviour(host: OptionsHost, patch: Partial<Behaviour>): void {
  const current = host.settings();
  host.save({ ...current, behaviour: { ...current.behaviour, ...patch } });
}

function saveFields(host: OptionsHost, fields: readonly Matcher[]): void {
  const current = host.settings();
  host.save({ ...current, exclusions: { ...current.exclusions, fields } });
}

function saveDomains(host: OptionsHost, domains: readonly string[]): void {
  const current = host.settings();
  host.save({ ...current, exclusions: { ...current.exclusions, domains } });
}

/**
 * Every section on this page, so the caller mounts them in one loop.
 *
 * A table rather than seven calls, because the page has to do this twice — once
 * on load and again whenever another writer's settings are adopted (UC-024) —
 * and two lists that must stay in step is how a section comes to be built at
 * load and never refreshed.
 *
 * The ids are the element ids in `index.html`. A section whose host element is
 * missing renders nothing and says nothing, which is the same outcome the rule
 * editor has and for the same reason: the page is markup we ship, so a missing
 * host is a build fault rather than a runtime condition worth reporting.
 */
export const SECTIONS: ReadonlyArray<{
  readonly id: string;
  readonly render: (host: OptionsHost, into: HTMLElement) => void;
}> = [
  { id: 'general', render: renderGeneral },
  { id: 'profiles', render: renderProfiles },
  { id: 'sources', render: renderSources },
  { id: 'field-exclusions', render: renderFieldExclusions },
  { id: 'domain-exclusions', render: renderDomainExclusions },
  { id: 'behaviour', render: renderBehaviour },
  { id: 'passwords', render: renderPasswords },
  { id: 'triggers', render: renderTriggers },
];
