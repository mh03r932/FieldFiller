import { message, type MessageKey } from '@/lib/platform/i18n';
import type { Profile, Settings } from '@/lib/settings';
import { appendAt, moveAt, removeAt, replaceAt } from '@/lib/lists';
import { newProfile, profileName } from '@/lib/profiles';
import { validateDomainPattern } from '@/lib/rules/validate';
import { checkbox, field, focusIn, textInput } from './controls';
import type { OptionsHost } from './host';
import { rowAt, rowMovedUnderYou } from './rows';
import { closeRuleIn, markOff, profileRules, renderRules } from './rules';

/**
 * URL profiles: named rule sets scoped to the pages they belong to
 * (UC-014, UC-015, UC-016; FR-045, FR-046).
 *
 * Its own module rather than a seventh entry in `sections.ts`, because it is not
 * the same shape as the six there. Those are forms over a flat slice of the
 * schema; this is a list of items each containing *another* list with its own
 * editor — the only place on the page where two levels of list meet.
 *
 * The rules inside a profile are edited by the rule editor itself, through a
 * lens (`profileRules`). Nothing about authoring a rule differs inside a
 * profile: the same thirteen generators, the same validation, the same preview,
 * the same reordering. A second editor would have been a second set of defects.
 */

/** Which profile is expanded. One at a time, as with rules: the list is context. */
let openProfileId: string | undefined;

/**
 * Expands one profile, or none, and takes the previous one's rule editor with it.
 *
 * The only writer of `openProfileId`, which is the point. A profile's rules are
 * drawn *inside* that profile, so collapsing it — or replacing it with another —
 * destroys the rule editor's DOM. It did not destroy the rule editor's memory of
 * what was open, and that outlived the screen in a way the user could not undo:
 * `isEditingRule` went on answering yes, so the page's storage listener took the
 * "adopt into memory, leave the DOM alone" branch for every later foreign write
 * and the global rule list stopped refreshing for the rest of the session, while
 * each adoption went on carrying a draft whose editor no longer existed.
 *
 * Only the profile that is losing its editor, and only when it is losing it: a
 * rule open in the global list belongs to nobody here and is not this function's
 * to close (BR-015-2).
 */
function openProfile(id: string | undefined): void {
  if (openProfileId !== undefined && openProfileId !== id) {
    closeRuleIn(profileRules(openProfileId).key);
  }
  openProfileId = id;
}

/**
 * Whether a profile is open.
 *
 * Exported for the page's storage listener for the same reason `isEditingRule`
 * is: adopting another writer's settings re-renders, and re-rendering this
 * section while a profile is open would collapse it and take the caret with it.
 */
export function isEditingProfile(): boolean {
  return openProfileId !== undefined;
}

/**
 * Closes the editor when the profile it belongs to has been deleted by somebody
 * else (UC-015 A4).
 *
 * The page skips this section while a profile is open, so that adopting another
 * writer's settings cannot collapse the editor under the caret. That skip has no
 * end condition of its own: if their write was the *deletion* of the open
 * profile, the editor stayed on screen over a profile that no longer exists —
 * `live()` fell back to the object it was built from, every further edit computed
 * `replaceAt(profiles, -1, …)` and wrote nothing, and the section went on being
 * skipped for every later change too. A ghost that silently swallows typing is a
 * worse outcome than the collapse the skip exists to prevent.
 *
 * The rule draft inside it is already handled — `adoptKeepingEdit` finds no
 * profile to write back to and drops it, which is A4's first step. This is the
 * same decision applied to the surface: the list is gone, so its editor goes,
 * and the profile is not resurrected to keep it company.
 *
 * Returns whether it closed one, so the caller can say so rather than leaving the
 * editor to vanish with no explanation.
 */
export function closeIfProfileGone(settings: Settings): boolean {
  if (openProfileId === undefined) return false;
  if (settings.profiles.some((candidate) => candidate.id === openProfileId)) return false;

  openProfile(undefined);
  return true;
}

export function renderProfiles(host: OptionsHost, into: HTMLElement): void {
  const profiles = host.settings().profiles;
  into.replaceChildren();

  if (profiles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    // No profiles is a working configuration — the global rules run everywhere —
    // and saying so is the difference between an empty state and a broken one.
    empty.textContent = message('profilesEmpty');
    into.append(empty);
  } else {
    const list = document.createElement('ol');
    list.className = 'rule-list';
    for (const [index, profile] of profiles.entries()) {
      list.append(profileRow(host, profile, index, profiles.length, into));
    }
    into.append(list);
  }

  const add = document.createElement('button');
  add.type = 'button';
  // `profile-add` as well as `primary`, because an open profile contains the
  // rule editor and *its* Add button is also `.primary` — and it comes first in
  // document order, being inside the list this one follows. Anything selecting
  // "the primary button in this section" gets the wrong one, which is how the
  // harness came to add a rule where it meant to add a profile. A person reading
  // the screen has the labels to tell them apart; nothing else did.
  add.className = 'primary profile-add';
  add.textContent = message('profileAdd');
  add.addEventListener('click', () => {
    const id = crypto.randomUUID();
    // Appended, never inserted: the first matching profile wins, so any other
    // position would change which profile governs pages the existing ones
    // already match (BR-014-2).
    save(host, appendAt(host.settings().profiles, newProfile(id)));
    openProfile(id);
    renderProfiles(host, into);
    focusIn(into, `[data-profile="${id}"] input[type="text"]`);
  });
  into.append(add);
}

function profileRow(
  host: OptionsHost,
  profile: Profile,
  index: number,
  total: number,
  into: HTMLElement,
): HTMLElement {
  const item = document.createElement('li');
  item.className = 'rule';
  item.dataset['profile'] = profile.id;

  const header = document.createElement('div');
  header.className = 'rule-header';

  const disclose = document.createElement('button');
  disclose.type = 'button';
  disclose.className = 'rule-name profile-name';
  disclose.setAttribute('aria-expanded', String(openProfileId === profile.id));
  disclose.textContent = nameOf(profile);
  disclose.addEventListener('click', () => {
    openProfile(openProfileId === profile.id ? undefined : profile.id);
    renderProfiles(host, into);
    // Back onto the button the rebuild destroyed, or a keyboard user is
    // returned to the top of the page after every expand (WCAG 2.4.3).
    focusIn(into, `[data-profile="${profile.id}"] .profile-name`);
  });

  markOff(disclose, profile);

  const problem = problemOf(profile);
  if (problem !== undefined) disclose.append(flagFor(problem));

  header.append(
    disclose,
    ordering(host, profile, index, total, into),
    remove(host, profile, into),
  );
  item.append(header);

  if (openProfileId === profile.id) {
    item.append(editor(host, profile, into));
  } else {
    item.append(summaryLine(profile));
  }
  return item;
}

/**
 * What a closed profile claims, in one line (UC-014).
 *
 * Which pages a profile governs is the whole of what distinguishes one from
 * another, and the row showed a name. Two profiles called "Staging" and "Live"
 * are indistinguishable from the list, which is exactly the moment a tester asks
 * "which of these was running?" — and the report line answering that names the
 * profile, not its patterns.
 *
 * A profile with no patterns says so here rather than only inside its editor. It
 * matches no page at all, and that is worth reading without opening it.
 */
function summaryLine(profile: Profile): HTMLElement {
  const line = document.createElement('p');
  line.className = 'rule-summary';
  // The whole line, not a slot in it, when there are no patterns: a profile that
  // matches no page has no interesting rule count, and the two read as one
  // run-on sentence when concatenated.
  line.textContent =
    profile.urls.length === 0
      ? message('profileNoUrlsShort')
      : message('profileSummary', [profile.urls.join(', '), String(profile.rules.length)]);
  return line;
}

/**
 * Move up and move down (BR-014-2).
 *
 * Buttons rather than a drag, for the reason UC-012 gives for rules: this *is*
 * the interaction, and the cheapest way to satisfy NFR-019 is to need nothing.
 * Order matters here for the same reason it matters there — it decides which of
 * two overlapping profiles governs a page — so it has to be operable and
 * visible, not implicit in creation order.
 */
function ordering(
  host: OptionsHost,
  profile: Profile,
  index: number,
  total: number,
  into: HTMLElement,
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
    button.dataset['direction'] = direction === -1 ? 'up' : 'down';
    button.setAttribute('aria-label', `${message(key)}: ${nameOf(profile)}`);
    button.title = message(key);
    button.disabled = disabled;
    button.addEventListener('click', () => {
      // Found by id, in the list as it stands — the argument the delete button
      // below makes at length, reached through the other door. This row's index
      // was chosen when it was drawn, and the page deliberately does not redraw
      // this section while a profile is open or while it holds the focus, so
      // another writer deleting or reordering a profile above this one leaves
      // the captured position naming somebody else. Moving the wrong profile
      // changes which of two overlapping profiles governs a page (BR-014-2),
      // silently, in a row the user was not looking at.
      const profiles = host.settings().profiles;
      const at = profiles.findIndex((candidate) => candidate.id === profile.id);
      if (at === -1) {
        rowMovedUnderYou(host, into, () => renderProfiles(host, into), '.profile-add');
        return;
      }

      const moved = moveAt(profiles, at, direction);
      save(host, moved);
      const position = moved.findIndex((candidate) => candidate.id === profile.id) + 1;
      host.announce(
        message('profileMoved', [nameOf(profile), String(position), String(moved.length)]),
      );

      renderProfiles(host, into);
      // The button that was pressed, falling back to whichever is still enabled
      // when the profile has reached an end. Aiming at the first enabled button
      // would hand a downward move to the up arrow, so the next press undoes it.
      const rowSelector = `[data-profile="${profile.id}"] .rule-order button`;
      const pressed = into.querySelector<HTMLButtonElement>(
        `${rowSelector}[data-direction="${direction === -1 ? 'up' : 'down'}"]`,
      );
      const target =
        pressed !== null && !pressed.disabled
          ? pressed
          : into.querySelector<HTMLButtonElement>(`${rowSelector}:not(:disabled)`);
      target?.focus();
    });
    group.append(button);
  }
  return group;
}

/**
 * Deletes a profile, and its rules with it (UC-016).
 *
 * Confirmed, unlike a rule deletion — which is the one place this section
 * deliberately departs from the rule editor beside it. A rule is one line and
 * BR-011-1's argument holds: immediate and reversible beats confirmed and
 * permanent. A profile can contain any number of rules the user spent an
 * afternoon writing, and an undo offer that survives only until the page closes
 * is not a proportionate safety net for that much work.
 */
function remove(host: OptionsHost, profile: Profile, into: HTMLElement): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rule-delete profile-delete';
  button.textContent = message('profileDelete');
  button.setAttribute('aria-label', `${message('profileDelete')}: ${nameOf(profile)}`);
  button.addEventListener('click', () => {
    // Found by id, in the list as it stands. `indexOf(profile)` was the object
    // this row was *built* from, and every edit inside the editor replaces it:
    // `update` writes a new profile and patches the header rather than rebuilding
    // the row, precisely so the caret survives. So after any edit the captured
    // object was no longer in the list, `indexOf` answered -1, and
    // `removeAt(list, -1)` filtered on a position no entry has — the list was
    // saved unchanged while the deletion was announced and the editor collapsed.
    // Naming a profile and then deleting it is the shortest path to it, which is
    // to say the ordinary one.
    const profiles = host.settings().profiles;
    const at = profiles.findIndex((candidate) => candidate.id === profile.id);

    // The profile as it stands, for the question and the announcement. The
    // captured one carries the name and rule count from before the edits, and a
    // confirmation stating the cost of a profile other than the one about to be
    // deleted is not the confirmation BR-016-2 asks for.
    const current = profiles[at] ?? profile;
    const count = current.rules.length;
    // The count is in the question, because "delete this profile?" and "delete
    // this profile and the 14 rules in it?" are different questions and only one
    // of them is the one being asked.
    const confirmed = globalThis.confirm(
      count === 0
        ? message('profileDeleteConfirmEmpty', [nameOf(current)])
        : message('profileDeleteConfirm', [nameOf(current), String(count)]),
    );
    if (!confirmed) return;

    // Already gone, because another writer deleted it while this page had it on
    // screen. There is nothing to remove, and writing the list back would be this
    // page asserting a state it did not compose. The row goes either way, which
    // is both what the user asked for and where they already are (UC-015 A4).
    if (at !== -1) save(host, removeAt(profiles, at));
    if (openProfileId === profile.id) openProfile(undefined);
    host.announce(message('profileDeleted', [nameOf(current)]));
    renderProfiles(host, into);
    // `.profile-add`, not `button.primary`. An open profile contains the rule
    // editor and *its* Add button is also `.primary` and comes first in document
    // order — the ambiguity this class was added to fix, walked into by the one
    // selector that had not been updated.
    focusIn(into, '.profile-add');
  });
  return button;
}

function editor(host: OptionsHost, profile: Profile, into: HTMLElement): HTMLElement {
  const body = document.createElement('div');
  body.className = 'rule-body';

  // The profile as it stands, not as it was when these controls were built —
  // the rule editor's `live()`, for the same reason: two edits in a row must
  // not compute the second from the state before the first.
  const live = (): Profile =>
    host.settings().profiles.find((candidate) => candidate.id === profile.id) ?? profile;

  const update = (next: Profile): void => {
    const profiles = host.settings().profiles;
    save(host, replaceAt(profiles, profiles.findIndex((p) => p.id === next.id), next));
    // The header follows, without rebuilding the body and taking the caret with
    // it. Both parts of it: the name *and* the flag.
    //
    // The flag was missed at first, and the failure was the whole point of the
    // control — a profile with no address patterns is flagged as matching
    // nothing, and typing the pattern that fixes it left the flag standing. So
    // the one state the flag exists to report was also the one state in which it
    // lied, and it took a browser harness to see it: every unit test asserts
    // what `problemOf` returns, which was right all along.
    const header = into.querySelector(`[data-profile="${profile.id}"]`);
    if (header === null) return;

    const name = header.querySelector('.profile-name');
    if (name instanceof HTMLElement && name.firstChild !== null) {
      name.firstChild.textContent = nameOf(next);
    }

    // The accessible names of the row's other controls, which embed the profile's
    // name too. Found alongside the flag: the visible header was being kept true
    // and "Delete: Staging" was left announcing a profile that had since been
    // renamed — the one reading a screen-reader user has, and the only one that
    // could send them to delete the wrong thing (NFR-019).
    for (const [selector, key] of [
      ['.profile-delete', 'profileDelete'],
      ['.rule-order button[data-direction="up"]', 'ruleMoveUp'],
      ['.rule-order button[data-direction="down"]', 'ruleMoveDown'],
    ] as ReadonlyArray<readonly [string, MessageKey]>) {
      header.querySelector(selector)?.setAttribute('aria-label', `${message(key)}: ${nameOf(next)}`);
    }

    const problem = problemOf(next);
    const flag = header.querySelector('.rule-flag');
    if (problem === undefined) {
      flag?.remove();
    } else if (flag instanceof HTMLElement) {
      flag.title = problem;
    } else if (name instanceof HTMLElement) {
      name.append(flagFor(problem));
    }
  };

  body.append(
    field(
      message('profileLabel'),
      textInput(profile.label, (value) => update({ ...live(), label: value })),
      message('profileLabelHint'),
    ),
    checkbox(message('profileEnabled'), profile.enabled, (value) =>
      update({ ...live(), enabled: value })),
    urls(host, profile, live, update, into),
  );

  // The profile's own rules, through the rule editor itself. A heading, because
  // the reader has to be able to tell these from the global list further down
  // the page — they look identical and behave identically, and the only thing
  // that distinguishes them is which pages they run on. An h3, the level the
  // rule editor's own groups use, so a heading inside an editor is one level
  // everywhere and the page's outline stays h1 → h2 → h3 → h4 all the way down.
  const heading = document.createElement('h3');
  heading.textContent = message('profileRulesHeading');
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = message('profileRulesHint');

  const rulesHost = document.createElement('div');
  rulesHost.className = 'profile-rules';
  renderRules(host, rulesHost, profileRules(profile.id));

  body.append(heading, hint, rulesHost);
  return body;
}

/**
 * The URL patterns a profile applies to (FR-045).
 *
 * The same glob vocabulary the domain exclusions use, and validated by the same
 * function — one matcher, one validator, so a pattern cannot mean one thing in
 * the exclusion list and another here. Over-matching is the more dangerous
 * direction for a profile, though, and that asymmetry is worth knowing: a
 * too-broad *exclusion* refuses a fill and says so, while a too-broad *profile*
 * silently changes which rules ran.
 */
function urls(
  host: OptionsHost,
  profile: Profile,
  live: () => Profile,
  update: (profile: Profile) => void,
  into: HTMLElement,
): HTMLElement {
  const group = document.createElement('fieldset');
  group.className = 'group';
  const legend = document.createElement('legend');
  legend.textContent = message('profileUrls');
  group.append(legend);

  // Once, above the patterns, rather than under each of them. The hint is two
  // lines and never varies, so a profile scoped to three addresses printed the
  // same two lines three times and buried its own list in them.
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = message('domainPatternHint');
  group.append(hint);

  if (profile.urls.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'problem';
    // A problem, not a note. A profile with no patterns matches no page, so it
    // is inert — and inert-but-listed is exactly the state UC-014 A2 exists to
    // make visible rather than leave the user to discover.
    empty.textContent = message('profileNoUrls');
    group.append(empty);
  }

  for (const [index, pattern] of profile.urls.entries()) {
    const row = document.createElement('div');
    // `pattern-row`, not the two-column `.row` this used to be. The grid sizes
    // its first column to that column's content, and the content was a field
    // carrying the two-line hint above — 572px of max-content against 190px
    // without it — so the Remove button beside it was pushed 8px past the
    // fieldset's own edge and clipped. The exclusion lists have the same field
    // plus button shape and have always wrapped instead; this is that rule.
    row.className = 'pattern-row';
    // Addressed by position, the way the exclusion lists address their rows.
    // What this replaces was `.row:nth-of-type(n)`, which counts *div* siblings
    // — and the problem lines between the rows are divs too, so it named the
    // right element only for the first pattern and matched nothing from the
    // second on. The focus then fell to `<body>` after the rebuild, silently,
    // because `focusIn` reports a miss and this caller had nothing to report to.
    row.dataset['url'] = String(index);

    // Addressed by position in a list that carries no identifiers of its own, so
    // the row checks that its position still holds what it was drawn from before
    // it writes anything. This section is not redrawn while a profile is open,
    // which is exactly when someone is typing into these boxes, and a foreign
    // write to the same profile's patterns would otherwise have this row rewrite
    // or delete a pattern the user never looked at (`rows.ts`).
    const slot = rowAt(() => live().urls, index, pattern);
    const moved = (): void => {
      rowMovedUnderYou(
        host,
        into,
        () => renderProfiles(host, into),
        `[data-profile="${profile.id}"] .profile-add-url`,
      );
    };

    const problems = document.createElement('div');
    problems.className = 'problems';
    problems.setAttribute('role', 'alert');
    const showProblem = (value: string): void => {
      problems.replaceChildren();
      const code = validateDomainPattern(value);
      if (code === undefined) return;
      const line = document.createElement('p');
      line.className = 'problem';
      line.textContent = message(code);
      problems.append(line);
    };
    showProblem(pattern);

    const input = field(
      message('profileUrlPattern'),
      textInput(pattern, (value) => {
        if (slot.entry() === undefined) {
          moved();
          return;
        }
        update({ ...live(), urls: replaceAt(live().urls, index, value) });
        slot.wrote(value);
        showProblem(value);
      }),
    );

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'exclusion-delete';
    drop.textContent = message('exclusionRemove');
    drop.setAttribute(
      'aria-label',
      `${message('exclusionRemove')}: ${pattern === '' ? message('exclusionUnnamed') : pattern}`,
    );
    drop.addEventListener('click', () => {
      if (slot.entry() === undefined) {
        moved();
        return;
      }
      update({ ...live(), urls: removeAt(live().urls, index) });
      renderProfiles(host, into);
      focusIn(into, `[data-profile="${profile.id}"] .profile-add-url`);
    });

    row.append(input, drop);
    group.append(row, problems);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'profile-add-url';
  add.textContent = message('profileAddUrl');
  add.addEventListener('click', () => {
    const at = live().urls.length;
    update({ ...live(), urls: appendAt(live().urls, '') });
    renderProfiles(host, into);
    focusIn(into, `[data-profile="${profile.id}"] [data-url="${String(at)}"] input`);
  });
  group.append(add);
  return group;
}

/**
 * The `!` beside a profile's name.
 *
 * The word is in the `title` rather than beside the mark, which is DD-006's
 * known weakness restated: the flag alone carries the fact in a glyph and a
 * colour. It is the rule editor's existing treatment and is kept identical
 * rather than improved here, so the two lists do not speak differently about
 * the same thing.
 */
function flagFor(problem: string): HTMLElement {
  const flag = document.createElement('span');
  flag.className = 'rule-flag';
  flag.textContent = '!';
  flag.title = problem;
  return flag;
}

/** What is wrong with a profile, for the header flag. `undefined` when nothing is. */
function problemOf(profile: Profile): string | undefined {
  if (profile.urls.length === 0) return message('profileNoUrls');
  const bad = profile.urls.find((pattern) => validateDomainPattern(pattern) !== undefined);
  return bad === undefined ? undefined : message(validateDomainPattern(bad)!);
}

function nameOf(profile: Profile): string {
  // The fallback to the first pattern is `profileName`, shared with the
  // background so the report cannot name a profile differently from the list
  // that shows it. Only the last resort is local, because it is a translation.
  //
  // `profileUnnamedTitle`, not `profileUnnamed`. The latter is written to sit
  // inside a button's accessible name — "Remove: this unnamed profile" — and was
  // being reused as the row's visible heading, where "this unnamed profile"
  // reads as a sentence fragment pointing at something. The rule list never had
  // the bug: `ruleUnnamed` is "Unnamed rule" and is only ever a title.
  return profileName(profile) ?? message('profileUnnamedTitle');
}

function save(host: OptionsHost, profiles: readonly Profile[]): void {
  host.save({ ...host.settings(), profiles });
}
