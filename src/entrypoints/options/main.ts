import { browser } from 'wxt/browser';
import { localise, message } from '@/lib/platform/i18n';
import { getSettings, saveSettings } from '@/lib/platform/settings-store';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '@/lib/settings';
import { profileSentence, resultSentence, scopeRuleSentence } from '@/lib/report/surface';
import {
  adoptKeepingEdit,
  closeAnyRule,
  forgetUndo,
  isEditingRule,
  renderRules,
  type RuleEditorHost,
} from './rules';
import { focusIn } from './controls';
import { reason } from './reason';
import { SECTIONS } from './sections';
import { closeIfProfileGone, isEditingProfile } from './profiles-section';
import type { FieldReportEntry, FillReport, ReportResponse } from '@/lib/protocol';

/**
 * Options page. Every settings surface the extension has, plus the per-control
 * report DD-006 put here.
 *
 * Sections on one scrolling page rather than tabs, so every setting stays
 * findable with the browser's own find-in-page and there is no navigation state
 * to keep accessible.
 *
 * Every user-facing string comes from the i18n catalog (NFR-018), and every
 * value that came from a page is written with `textContent` rather than any form
 * of markup assembly: a field labelled `<img onerror=…>` is a label, not an
 * element, and it must be impossible for it to become one.
 */

document.title = message('extName');
localise(document);

void render();
void mountSettings();

/**
 * Every settings section, and the state they all edit (UC-009..UC-013,
 * UC-018..UC-023).
 *
 * Held here in memory and written through on every valid change. The write goes
 * to the same store the background reads, and the background drops its cache on
 * a storage change — so a setting edited here applies to the next fill in every
 * open tab with nothing pushed anywhere (UC-024, BR-024-6).
 *
 * One state and one writer for the whole page. Each section could have loaded
 * and saved its own slice, and that is the shape that loses configuration: two
 * sections holding two snapshots means whichever saves second reverts the other,
 * within a single page, with no error anywhere.
 */
async function mountSettings(): Promise<void> {
  const host = document.querySelector('#rules');
  const live = document.querySelector('#announcements');
  if (!(host instanceof HTMLElement)) return;

  let settings: Settings = DEFAULT_SETTINGS;
  try {
    settings = await getSettings();
  } catch {
    // A page that cannot read settings shows the defaults rather than nothing:
    // the defaults are a complete, self-consistent state.
  }

  const announce = (text: string): void => {
    if (live instanceof HTMLElement) live.textContent = text;
  };

  const editor: RuleEditorHost = {
    settings: () => settings,
    save: (next) => {
      // Optimistic in memory, durable in storage. A rejected write leaves
      // storage holding the previous state (BR-024-2), which means the page is
      // then ahead of storage and the next load silently undoes what the user
      // did — so the rejection is not something to swallow.
      //
      // UC-024 A2/A3 asks for exactly this: the surface that requested the
      // change is told the change did not take effect, and why. It goes to the
      // live region rather than an alert, because every other outcome on this
      // page is announced the same way and a failed save is not more modal
      // than a successful one.
      settings = next;
      void saveSettings(next).catch((error: unknown) => {
        announce(message('settingsSaveFailed', [reason(error)]));
      });
    },
    announce,
    /**
     * UC-026's write: the whole configuration at once, and the caller finds out.
     *
     * Memory first, then storage, in that order and for `save`'s reason — but
     * the rejection is re-thrown rather than swallowed. An import is the one
     * change on this page whose caller has something left to do about a failed
     * write: A7 says the previous configuration is still in force and the
     * import did not happen, and the section keeps its plan on screen so the
     * user can try again. Announced here, so a rejected write is worded the
     * same however it was made.
     *
     * **And memory goes back, which `save` does not do.** A7's "still in force"
     * has to be true of the page as well as of storage: `settings()` is what
     * every other section computes its next write from, so a failed import that
     * left the imported state in memory would be applied by the next keystroke
     * anywhere on the page — a checkbox in the behaviour section writing a whole
     * configuration the user was told had not been imported. UC-024 A2 accepts
     * that divergence for a single field, where the next write re-states the
     * same field; it is a different bargain when what is left in memory is every
     * rule and every profile the user still has.
     *
     * Only if nothing else has taken memory in the meantime. The adopt listener
     * below runs on storage events and can land during the await, and its state
     * came from storage — restoring over it would revert a write this page did
     * not make and could not see, which is BR-024-3's defect committed by the
     * rollback meant to prevent one.
     */
    replace: async (next) => {
      const previous = settings;
      settings = next;
      try {
        await saveSettings(next);
      } catch (error: unknown) {
        if (settings === next) settings = previous;
        announce(message('settingsSaveFailed', [reason(error)]));
        throw error;
      }
    },
    /**
     * Everything, from the state now in memory (UC-026).
     *
     * An import replaces every list on the page, so every editor open over one
     * of them is open over something that no longer exists — the rule editor
     * and, if its profile went with the import, the profile editor. Both are
     * closed before anything is drawn, because a render is what would otherwise
     * leave their state pointing at a list the page has stopped drawing.
     */
    redraw: () => {
      closeAnyRule();
      forgetUndo(host);
      closeIfProfileGone(settings);
      renderRules(editor, host);
      renderEverySection(editor);
    },
  };

  renderRules(editor, host);
  renderSections(editor);

  /**
   * Adopts settings written by anyone else (UC-024, BR-024-3).
   *
   * This page holds the whole state in memory for its lifetime and writes all of
   * it on every change, so a second writer is a real way to lose configuration
   * rather than a theoretical one: open the options page in two tabs, add a rule
   * in each, and the tab that saves second reverts the first tab's rule with no
   * error anywhere. Two tabs is not an exotic setup, and today the extension
   * itself never writes settings — so the *only* second writer is another copy
   * of this page.
   *
   * Adopting keeps memory level with storage, which is what makes the next write
   * from this page correct rather than a rollback.
   *
   * Not by re-rendering while a rule is open, though. Replacing the list under
   * someone mid-edit discards the rule they are still writing — a new rule lives
   * only in this page's memory until it validates — and losing the edit in front
   * of you is worse than the staleness it would fix. Memory is still brought
   * level, with the draft carried across; only the DOM is left alone, and it
   * catches up when the rule closes.
   *
   * Adopting *only* into memory is what makes the advice safe to follow. Telling
   * the user to finish their rule while this page still held the pre-change
   * snapshot walked them into the loss it was warning about: the next valid
   * keystroke wrote the whole stale state back and reverted the other tab.
   */
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !('settings' in changes)) return;
    void getSettings().then((stored) => {
      // Our own write comes back through here too, and it is *not* what we asked
      // for: `saveSettings` normalises the candidate and stores the result, so
      // the echo differs from memory whenever the parser reshaped anything — a
      // half-written rule it drops, a clamped bound, even a key it emits in a
      // different order. Comparing raw memory against it called every one of
      // those somebody else's write. Adding a rule did it every time, because a
      // new rule has an empty pattern and the parser drops it.
      //
      // Both sides through the parser, so the comparison is between two states
      // in the same normal form and answers the question actually being asked:
      // does storage hold something this page did not put there?
      if (JSON.stringify(stored) === JSON.stringify(parseSettings(settings))) return;

      // The undo offer belongs to the list it was deleted from, and this is a
      // different list — its stored position would land the rule somewhere
      // nobody chose.
      forgetUndo(host);

      if (isEditingRule()) {
        // Foreign, and a rule is open. Take their state, carry our draft across,
        // and leave the rule list alone.
        settings = adoptKeepingEdit(stored, settings);
        announce(message('settingsChangedElsewhere'));
      } else {
        settings = stored;
        // The same host object, re-rendered. Building a new one here — or
        // calling `mountSettings` again — would register a second copy of this
        // listener on every foreign change, which is a leak that grows for as
        // long as the page stays open.
        renderRules(editor, host);
        announce(message('settingsAdoptedFromElsewhere'));
      }

      // Checked before the sections are drawn, so the profiles section is no
      // longer skipped on behalf of an editor whose profile they deleted
      // (UC-015 A4). Announced over the general adoption sentence above, because
      // it is the more specific thing that just happened to this user: their
      // editor is about to disappear, and the general sentence does not account
      // for it.
      const profileGone = closeIfProfileGone(settings);
      if (profileGone) announce(message('profileRemovedElsewhere'));

      // The other sections either way: none of them holds a draft the way an
      // open rule does, so there is nothing for a rebuild to discard — except
      // the caret, which is why `renderSections` skips whatever is focused.
      renderSections(editor, profileGone ? 'profiles' : undefined);
    });
  });
}

/**
 * Draws every section except the one the user is working in.
 *
 * The exception is the whole reason this is not a loop at the call site.
 * Replacing a section's children destroys the control that has the focus and
 * takes the caret with it, so a settings change arriving from another tab while
 * someone is halfway through typing a domain pattern would eat the rest of their
 * keystrokes — the same hazard the rule editor's draft exists for, reached
 * through a different door.
 *
 * The skipped section is left showing the older state until the next render —
 * unless it exposes a `refresh`, which the skip calls instead of nothing. That
 * is for the one section whose focused control is not somebody's typing but a
 * confirmation holding it: the restore confirmation's counts are the
 * confirmation (BR-028-2), and its designed state — the cancel button focused —
 * is exactly the state this rule skips. `refresh` patches the computed lines in
 * place and touches no control, so the focus this rule exists to protect is
 * still there after it.
 *
 * Everywhere else, the staleness is the lesser fault by some distance: it is
 * stale rather than lost, the user is told a change arrived, and this page's
 * memory is level with storage either way — so the next thing they type saves
 * against *their* state and not over it.
 *
 * `force` names the one section that must be drawn regardless, and it exists for
 * a case where both exemptions above argue the wrong way: the open profile has
 * been deleted by somebody else (UC-015 A4). Its editor then edits nothing —
 * every keystroke computes a write against a profile that is not in the list and
 * saves the list unchanged — so preserving the caret preserves it inside a
 * control that silently discards typing. The caret is taken, the announcement
 * says why, and the focus is put somewhere real by the caller.
 */
function renderSections(editor: RuleEditorHost, force?: string): void {
  const focused = document.activeElement;
  for (const [section, into] of sectionHosts()) {
    // Asked before the render, because rendering detaches whatever was focused
    // and `contains` would then answer no about the element it just destroyed.
    const heldFocus = focused !== null && into.contains(focused);

    if (section.id !== force) {
      if (heldFocus) {
        // Not drawn, but not necessarily uninformed: a section whose content is
        // computed from settings rather than typed into them may patch that
        // content in place, which is how the restore confirmation keeps its
        // counts true while it holds the focus. No control is rebuilt, which is
        // the whole reason the render was skipped.
        section.refresh?.(editor, into);
        continue;
      }
      // A profile holds an open item and a rule editor inside it, so it is
      // skipped on the same terms the rule list is: rebuilding it would collapse
      // the open profile and discard whatever rule was being written inside it.
      // It catches up when the profile closes.
      if (section.id === 'profiles' && isEditingProfile()) continue;
    }
    section.render(editor, into);

    // Only where the rebuild was forced, and therefore only where it may have
    // just destroyed the focused control. Everywhere else the section either was
    // not holding the focus or was skipped for holding it, so moving the focus
    // here would take it from wherever the user actually is.
    if (section.id === force && heldFocus) focusIn(into, '.profile-add');
  }
}

/**
 * Every section, skipping nothing (UC-026).
 *
 * The counterpart to `renderSections` above, and the exception to it. That one
 * leaves alone whatever holds the focus, because a settings change arriving from
 * another tab must not take the caret out from under someone's typing. After an
 * import there is nothing to protect and everything to correct: the user clicked
 * a button that replaced the whole configuration, so every section on screen is
 * describing a state that is gone, including the one they clicked in.
 */
function renderEverySection(editor: RuleEditorHost): void {
  for (const [section, into] of sectionHosts()) section.render(editor, into);
}

/**
 * Each section paired with the element it draws into, skipping any whose
 * element is not in the document.
 *
 * One place that knows how a section id becomes an element. Both renderers above
 * had their own copy of the lookup and the `instanceof` guard, which is three
 * lines of the five either of them is made of — and the guard is the part worth
 * having once, since it is what keeps a section listed in `SECTIONS` but absent
 * from `index.html` a no-op rather than a thrown error on every render.
 */
function sectionHosts(): readonly (readonly [(typeof SECTIONS)[number], HTMLElement])[] {
  const pairs: (readonly [(typeof SECTIONS)[number], HTMLElement])[] = [];
  for (const section of SECTIONS) {
    const into = document.querySelector(`#${section.id}`);
    if (into instanceof HTMLElement) pairs.push([section, into]);
  }
  return pairs;
}

async function render(): Promise<void> {
  const host = document.querySelector('#report');
  if (!(host instanceof HTMLElement)) return;

  const report = await requestReport();
  host.replaceChildren(report === undefined ? noReport() : reportView(report));
  renderReportLede(report);
}

/**
 * The one line about the last fill that sits under the page title (DD-006).
 *
 * The report is the last section on the page and stays there: a populated one
 * measures over 2000px against a 900px viewport, so anywhere among the settings
 * it buries them rather than dividing them, and it is empty most of the time
 * because the background is torn down between uses. What being last cost was
 * discoverability, which is what this pays, at the cost of one line that is not
 * drawn at all when there is nothing to say.
 *
 * `resultSentence` again, the same function the tooltip and the report's own
 * summary call. Three surfaces now state one fill's outcome and none of them can
 * word it differently, which is the whole reason that function is host-free and
 * takes its catalog as an argument.
 */
function renderReportLede(report: FillReport | undefined): void {
  const slot = document.querySelector('#report-lede');
  if (!(slot instanceof HTMLElement)) return;
  slot.replaceChildren();
  if (report === undefined) return;

  slot.append(message('reportLatest', [resultSentence(report, message)]), ' ');

  const jump = document.createElement('a');
  // To the heading rather than to the section, so a screen reader that follows
  // the link lands on the words naming what it just moved to.
  jump.href = '#report-heading';
  jump.textContent = message('reportJump');
  jump.addEventListener('click', focusReportHeading);
  slot.append(jump);
}

/**
 * Moves the focus with the link, not only the scroll (WCAG 2.4.3).
 *
 * A fragment link scrolls and leaves the focus where it was, and the browser
 * scrolls it back the moment anything asks for it: measured, the first Tab after
 * following this link landed on the link itself and dragged the page back to the
 * top, so a keyboard user was returned to where they started by the act of
 * trying to read on. The heading takes `tabindex="-1"` to be a focus target
 * without joining the tab order, which is the same arrangement a skip link uses.
 *
 * Set here rather than in the markup because it exists for this link, and this
 * link exists only when there is a report to jump to.
 */
function focusReportHeading(): void {
  const heading = document.querySelector('#report-heading');
  if (!(heading instanceof HTMLElement)) return;
  heading.tabIndex = -1;
  heading.focus();
}

/**
 * Asks the background for the last fill's report.
 *
 * `undefined` covers both answers that mean the same thing to this page: the
 * background holds no report, or the background is not running and the message
 * rejected. Either way there is nothing to show and the page says so.
 */
async function requestReport(): Promise<FillReport | undefined> {
  try {
    const response: unknown = await browser.runtime.sendMessage({ kind: 'report-request' });
    if (typeof response !== 'object' || response === null) return undefined;
    const candidate = response as Partial<ReportResponse>;
    return candidate.kind === 'report-response' ? candidate.report : undefined;
  } catch {
    return undefined;
  }
}

function noReport(): HTMLElement {
  const paragraph = document.createElement('p');
  paragraph.textContent = message('reportNone');
  return paragraph;
}

function reportView(report: FillReport): HTMLElement {
  const fragment = document.createElement('div');

  const summary = document.createElement('p');
  summary.className = 'report-summary';
  // The same sentence the tooltip carries, so the two surfaces cannot disagree
  // about what happened (DD-006) — the same *function*, now, which is what that
  // sentence had always claimed. A second copy lived here and drifted: it never
  // learned about refusals, so a fill that refused to guess which form was meant
  // was reported here as a form with nothing in it, and it dropped the
  // skipped-rules clause as well.
  //
  // Still built here rather than sent as a finished string: a sentence formatted
  // in the background would carry the background's locale, which is the same one
  // today and need not stay so. `resultSentence` is host-free by design and
  // takes the catalog it should use, so sharing it costs nothing.
  summary.textContent = resultSentence(report, message);
  fragment.append(summary);

  // BR-002-4: a ladder is only better than a heuristic if you can see which rung
  // answered. The badge and tooltip have no room for it (DD-006), and this is
  // the surface that does.
  const chosenBy = scopeRuleSentence(report, message);
  if (chosenBy !== undefined) {
    const rule = document.createElement('p');
    rule.className = 'report-scope-rule';
    rule.textContent = chosenBy;
    fragment.append(rule);
  }

  // FR-047, on the same surface and for the same reason. Present even when no
  // profile applied: "none" is the answer a tester checking whether their scoped
  // rules ran actually needs, and an absent line cannot give it.
  const profile = profileSentence(report, message);
  if (profile !== undefined) {
    const line = document.createElement('p');
    line.className = 'report-profile';
    // `textContent`: a profile label is whatever the user typed.
    line.textContent = profile;
    fragment.append(line);
  }

  if (report.fields.length > 0) fragment.append(table(report.fields));

  const privacy = document.createElement('p');
  privacy.className = 'report-privacy';
  // Stated on the surface itself, not only in the documentation. A user reading
  // their own field names back out of the extension is entitled to know how long
  // it kept them (NFR-010, NFR-030).
  privacy.textContent = message('reportPrivacyNote');
  fragment.append(privacy);

  return fragment;
}

function table(fields: readonly FieldReportEntry[]): HTMLElement {
  const table = document.createElement('table');
  table.className = 'report-table';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const key of ['reportColumnField', 'reportColumnOutcome', 'reportColumnDetail'] as const) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = message(key);
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const field of fields) body.append(row(field));

  table.append(head, body);
  return table;
}

function row(field: FieldReportEntry): HTMLElement {
  const row = document.createElement('tr');

  const name = document.createElement('th');
  name.scope = 'row';
  // `textContent`, always. This string came from a page.
  name.textContent = field.identity;

  const outcome = document.createElement('td');
  outcome.textContent = message(
    field.status === 'filled'
      ? 'reportStatusFilled'
      : field.status === 'skipped'
        ? 'reportStatusSkipped'
        : 'reportStatusFailed',
  );
  // A class rather than a colour alone: colour is not an accessible way to carry
  // the only copy of a fact (NFR-019), which is why the word is there too.
  outcome.className = `outcome outcome-${field.status}`;

  const detail = document.createElement('td');
  detail.className = 'detail';
  detail.textContent = field.detail;

  row.append(name, outcome, detail);
  return row;
}
