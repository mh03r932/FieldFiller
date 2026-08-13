import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import { agentSettings } from '@/lib/settings';
import { createPersona, seededRandom, type Persona, type Random } from '@/lib/persona/persona';
import { generateValue } from '@/lib/generators/default-generator';
import {
  isFromAgentMessage,
  type FillScope,
  type FrameReport,
  type OperationId,
  type ValuesResponse,
} from '@/lib/protocol';

/**
 * Background context — MV3 service worker on Chromium, event page on Firefox
 * (C-003, absorbed by WXT from this one file).
 *
 * It owns the settings, the persona and the generators, and maps every trigger
 * onto a fill. The page agent walks and applies; nothing that carries data
 * crosses into it (DD-003).
 *
 * Phase 1 implements the toolbar trigger and the page scope (UC-001). The
 * keyboard and context-menu channels are registered and still inert: they reach
 * the same scopes and must produce identical results when they land, because a
 * channel chooses which scopes it can reach and nothing else (BR-001-6).
 */

const MENU_ITEMS: ReadonlyArray<{ id: FillScope; titleMessage: MessageKey }> = [
  { id: 'all-inputs', titleMessage: 'menuFillAllInputs' },
  { id: 'current-form', titleMessage: 'menuFillCurrentForm' },
  { id: 'selected-input', titleMessage: 'menuFillSelectedInput' },
];

const COMMAND_SCOPES: Readonly<Record<string, FillScope>> = {
  'fill-all-inputs': 'all-inputs',
  'fill-current-form': 'current-form',
  'fill-selected-input': 'selected-input',
};

/**
 * Live fills, by operation id.
 *
 * The persona is created when the fill begins and held only for its lifetime
 * (BR-004-1a). NFR-031 requires generated data to be discarded when the fill
 * completes, so this map is cleared on the report — it is a working set, never a
 * cache, and nothing here is ever written to storage.
 */
type Operation = {
  readonly persona: Persona;
  readonly random: Random;
  readonly tabId: number;
  readonly outcomes: FieldOutcomeCounts;
};

type FieldOutcomeCounts = { filled: number; skipped: number; failed: number };

const operations = new Map<OperationId, Operation>();

/** Tabs with a fill in progress, so a second invocation is ignored (UC-001 A7). */
const filling = new Set<number>();

function trace(text: string): void {
  if (import.meta.env.COMMAND === 'serve') console.debug(`[fieldfiller] ${text}`);
}

async function registerContextMenus(): Promise<void> {
  try {
    await browser.contextMenus.removeAll();
    for (const item of MENU_ITEMS) {
      browser.contextMenus.create({
        id: item.id,
        title: message(item.titleMessage),
        contexts: ['page', 'editable'],
      });
    }
    trace(`registered ${MENU_ITEMS.length} context menu entries`);
  } catch (error) {
    // `onInstalled` has no error path, and an unhandled rejection here would be
    // reported as an extension error naming no channel. Awaited rather than
    // given a callback because Firefox's `browser.*` is promise-only and
    // validates arguments strictly — the callback form risks leaving every menu
    // silently absent there (NFR-017).
    trace(`context menu registration failed: ${String(error)}`);
  }
}

/**
 * Starts a fill on one tab.
 *
 * The persona precedes the descriptors (BR-004-1a): it is complete before the
 * page is asked what it contains, which is what lets several frames be filled
 * from one person without coordinating them.
 */
async function startFill(tabId: number, scope: FillScope): Promise<void> {
  if (filling.has(tabId)) {
    // UC-001 A7: a second invocation during a running fill is ignored rather
    // than queued. Two overlapping fills would write two personas into one form.
    trace(`fill already running in tab ${tabId}; ignoring`);
    return;
  }
  filling.add(tabId);

  const operationId = crypto.randomUUID();
  const random = seededRandom(Math.floor(Math.random() * 2 ** 32));
  const settings = await getSettings();

  operations.set(operationId, {
    persona: createPersona(random),
    random,
    tabId,
    outcomes: { filled: 0, skipped: 0, failed: 0 },
  });

  try {
    await browser.tabs.sendMessage(tabId, {
      kind: 'fill',
      operationId,
      scope,
      settings: agentSettings(settings),
    });
  } catch (error) {
    // UC-001 A4: no agent in this tab — a page that loaded before the extension
    // was installed, or one the browser does not permit acting on. Reported as
    // its own outcome rather than as a failed fill, because reloading fixes the
    // first and nothing fixes the second.
    trace(`no page agent in tab ${tabId}: ${String(error)}`);
    await showBadge(tabId, '—', '#8a8f98');
    finish(operationId, tabId);
  }
}

/** Ends an operation, discarding the persona and every generated value (NFR-031). */
function finish(operationId: OperationId, tabId: number): void {
  operations.delete(operationId);
  filling.delete(tabId);
}

/**
 * DD-006, provisionally: the count on the badge, then back to nothing.
 *
 * The reference fills silently, so a user cannot tell an empty page from an
 * excluded domain from a crash. A badge is the cheapest way to close that loop
 * and costs the page agent nothing — a toast would put our markup in the user's
 * document and spend bytes against the 40 KB budget.
 *
 * Transient on purpose. The badge is also where the active profile (UC-017) and
 * domain-off (UC-008) indicators will live, and those are persistent facts that
 * must win: a fill count is interesting for a moment, "this domain is excluded"
 * has to be true whenever you look.
 */
async function showBadge(tabId: number, text: string, colour: string): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: colour });
    await browser.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    }, 3000);
  } catch {
    // A tab that closed mid-fill cannot show a badge. Not a fill failure.
  }
}

function summarise(report: FrameReport, counts: FieldOutcomeCounts): void {
  for (const outcome of report.outcomes) counts[outcome.status]++;
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void registerContextMenus();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const scope = MENU_ITEMS.find((item) => item.id === info.menuItemId)?.id;
    if (scope === undefined || tab?.id === undefined) return;
    if (scope === 'all-inputs') void startFill(tab.id, scope);
    else trace(`context menu → ${scope} (Phase 3)`);
  });

  // FR-004: the toolbar reaches only "fill all inputs" — it has no cursor
  // position to derive a narrower scope from (BR-001-6). It is also the
  // zero-configuration path DD-007 leans on.
  browser.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void startFill(tab.id, 'all-inputs');
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const scope = COMMAND_SCOPES[command];
    if (scope === undefined || tab?.id === undefined) return;
    if (scope === 'all-inputs') void startFill(tab.id, scope);
    else trace(`command ${command} → ${scope} (Phase 3)`);
  });

  // The agent's half of the round trip: descriptors in, values out. Answered
  // with `sendResponse` and an explicit `return true`, which is the one form
  // both browsers agree on for an asynchronous reply.
  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!isFromAgentMessage(raw) || raw.kind === 'pong') return;

    // An unknown operation id is not an error: the background may have been
    // evicted and restarted since the fill began, taking the persona with it.
    // Nothing to answer with, so nothing is answered.
    const operation = operations.get(raw.operationId);
    if (operation === undefined) return;

    if (raw.kind === 'descriptors') {
      const values = raw.descriptors.map((descriptor) =>
        generateValue(descriptor, operation.persona, operation.random),
      );
      sendResponse({ kind: 'values', operationId: raw.operationId, values } satisfies ValuesResponse);
      return true;
    }

    {
      summarise(raw.report, operation.outcomes);
      const { filled, skipped, failed } = operation.outcomes;
      trace(`fill ${raw.operationId}: ${filled} filled, ${skipped} skipped, ${failed} failed`);

      // BR-001-4: nothing to fill is a success, not a failure, and must be
      // distinguishable from one.
      void showBadge(
        operation.tabId,
        filled > 0 ? String(filled) : '0',
        failed > 0 ? '#c0392b' : filled > 0 ? '#2f6fed' : '#8a8f98',
      );
      finish(raw.operationId, operation.tabId);
    }
    return;
  });

  trace('background ready');
});
