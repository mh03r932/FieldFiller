import { browser } from 'wxt/browser';
import { localise, message } from '@/lib/platform/i18n';
import type { FieldReportEntry, FillReport, ReportResponse } from '@/lib/protocol';

/**
 * Options page. Settings are Phase 4; what it carries today is DD-006's third
 * surface — the per-control report for the last fill.
 *
 * The badge holds a count and the tooltip holds a sentence. Neither can say
 * *why this field got that value*, which is FR-069's whole purpose, and the
 * answer needs a row per control. This is the surface with room for one.
 *
 * Every user-facing string comes from the i18n catalog (NFR-018), and every
 * value that came from a page is written with `textContent` rather than any form
 * of markup assembly: a field labelled `<img onerror=…>` is a label, not an
 * element, and it must be impossible for it to become one.
 */

document.title = message('extName');
localise(document);

void render();

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
  // about what happened (DD-006).
  summary.textContent = sentence(report);
  fragment.append(summary);

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

/**
 * The summary sentence.
 *
 * Rebuilt here from the catalog rather than sent as a finished string, because
 * a formatted sentence crossing the message boundary would be formatted in the
 * background's locale — which is the same one today and need not stay so.
 */
function sentence(report: FillReport): string {
  const scope = message(
    report.scope === 'current-form'
      ? 'resultScopeCurrentForm'
      : report.scope === 'selected-input'
        ? 'resultScopeSelectedInput'
        : 'resultScopeAllInputs',
  );
  const filled = String(report.counts.filled);

  if (report.capped === undefined) return message('resultSettled', [filled, scope]);

  const reason = message(
    report.capped === 'user-input'
      ? 'resultCapUserInput'
      : report.capped === 'time-budget'
        ? 'resultCapTimeBudget'
        : report.capped === 'values-unavailable'
          ? 'resultCapValuesUnavailable'
          : 'resultCapPassCap',
  );
  return message('resultCapped', [filled, scope, String(report.stale), reason]);
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
