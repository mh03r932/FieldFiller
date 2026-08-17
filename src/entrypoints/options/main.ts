import { browser } from 'wxt/browser';
import { localise, message } from '@/lib/platform/i18n';
import { getSettings, saveSettings } from '@/lib/platform/settings-store';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { resultSentence, scopeRuleSentence } from '@/lib/report/surface';
import { forgetUndo, isEditingRule, renderRules, type RuleEditorHost } from './rules';
import type { FieldReportEntry, FillReport, ReportResponse } from '@/lib/protocol';

/**
 * Options page. Two sections so far: the rule editor (UC-009..UC-013) and the
 * per-control report DD-006 put here.
 *
 * Sections on one scrolling page rather than tabs, so every setting stays
 * findable with the browser's own find-in-page and there is no navigation state
 * to keep accessible. The remaining Phase 4 screens land as more sections.
 *
 * Every user-facing string comes from the i18n catalog (NFR-018), and every
 * value that came from a page is written with `textContent` rather than any form
 * of markup assembly: a field labelled `<img onerror=…>` is a label, not an
 * element, and it must be impossible for it to become one.
 */

document.title = message('extName');
localise(document);

void render();
void mountRules();

/**
 * The rule editor, and the settings state it edits (UC-009..UC-013).
 *
 * Held here in memory and written through on every valid change. The write goes
 * to the same store the background reads, and the background drops its cache on
 * a storage change — so a rule edited here applies to the next fill in every
 * open tab with nothing pushed anywhere (UC-024, BR-024-6).
 */
async function mountRules(): Promise<void> {
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
        const reason = error instanceof Error ? error.message : String(error);
        announce(message('settingsSaveFailed', [reason]));
      });
    },
    announce,
  };

  renderRules(editor, host);

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
   * Not while a rule is open, though. Replacing the list under someone mid-edit
   * discards the rule they are still writing — a new rule lives only in this
   * page's memory until it validates — and losing the edit in front of you is
   * worse than the staleness it would fix. That case is told instead, because a
   * page that knows it is out of date and says nothing is the version of this
   * bug that was already here.
   */
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !('settings' in changes)) return;
    void getSettings().then((stored) => {
      // Our own write comes back through here too. It is not necessarily
      // identical to what we asked for — `saveSettings` normalises on the way in
      // — so the comparison is against what storage now holds, and an unchanged
      // result means there is nothing to adopt whoever wrote it.
      if (JSON.stringify(stored) === JSON.stringify(settings)) return;
      if (isEditingRule()) {
        announce(message('settingsChangedElsewhere'));
        return;
      }
      settings = stored;
      // The undo offer belongs to the list it was deleted from, and this is a
      // different list — its stored position would land the rule somewhere
      // nobody chose.
      forgetUndo();
      // The same host object, re-rendered. Building a new one here — or calling
      // `mountRules` again — would register a second copy of this listener on
      // every foreign change, which is a leak that grows for as long as the page
      // stays open.
      renderRules(editor, host);
      announce(message('settingsAdoptedFromElsewhere'));
    });
  });
}

async function render(): Promise<void> {
  const host = document.querySelector('#report');
  if (!(host instanceof HTMLElement)) return;

  const report = await requestReport();
  host.replaceChildren(report === undefined ? noReport() : reportView(report));
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
