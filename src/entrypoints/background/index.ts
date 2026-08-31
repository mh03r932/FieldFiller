import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { startSyncEngine } from '@/lib/platform/sync-store';
import { isFromAgentMessage, type FillScope } from '@/lib/protocol';
import { MENU_ITEMS, syncContextMenus } from './menus';
import { createOperations, realClock } from './operations';
import { answerReportRequest, holdReport, resultTitle } from './reporting';
import { startFill } from './fills';
import { clearBadgeOnNavigation, showBadge } from './badge';
import { trace } from './trace';

/**
 * Background context — MV3 service worker on Chromium, event page on Firefox
 * (C-003, absorbed by WXT from this entrypoint).
 *
 * It owns the settings, the persona and the generators, and maps every trigger
 * onto a fill. The page agent walks and applies; nothing that carries data
 * crosses into it (DD-003).
 *
 * All three trigger channels reach all three scopes as of Phase 3, and a scope
 * produces the same result whichever channel reached it: a channel decides which
 * scopes it can *offer* — the toolbar has no cursor to narrow from — and nothing
 * else (BR-001-6).
 *
 * This file is wiring and nothing else: each responsibility lives in its own
 * module — menus, badge, the operation registry, fill orchestration, the report
 * — and the seams are the injected clock and the completion hook below, which
 * are what make the registry's timing decisions testable without a browser
 * (NFR-015).
 */

const COMMAND_SCOPES: Readonly<Record<string, FillScope>> = {
  'fill-all-inputs': 'all-inputs',
  'fill-current-form': 'current-form',
  'fill-selected-input': 'selected-input',
};

const operations = createOperations({
  clock: realClock,
  // The one place a finished report lands. The report is held *before* the
  // badge is drawn (see `complete`), so the options page's next request can
  // never observe a badge for a report that does not exist yet.
  onCompleted: ({ report, tabId, badge }) => {
    holdReport(report);
    void showBadge(tabId, badge.text, badge.colour, resultTitle(report));
  },
});

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void syncContextMenus();
  });

  // Every start, not only installation. The menu is browser state and the
  // setting is ours, so the two can only be relied on to agree if something
  // reconciles them — and an MV3 worker that was evicted while the user turned
  // the menu off in another window has no other moment to learn of it.
  void syncContextMenus();

  /**
   * UC-029, both directions. Registered here and nowhere else, so `storage.sync`
   * has exactly one writer in the extension — the options page reads the replica
   * to draw its section and to offer step 3's choice, and writes only the local
   * preferences.
   *
   * At registration time rather than behind a settings read, for the reason the
   * menu reconciliation above is unconditional: an MV3 worker is started *by*
   * the event it needs to handle, and a listener attached after an await would
   * miss the change that woke it. Everything behind it is a no-op while the
   * feature is off, which is its shipped state (BR-029-1).
   */
  startSyncEngine();

  // UC-023 step 5: the change takes effect in pages already open. Nothing is
  // pushed to a tab — `contextMenus` is per-browser rather than per-page, so
  // rebuilding the entries *is* the propagation, and a page that was loaded
  // before the change shows the new menu on its next right-click (BR-023-4).
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'settings' in changes) void syncContextMenus();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const scope = MENU_ITEMS.find((item) => item.id === info.menuItemId)?.id;
    if (scope === undefined || tab?.id === undefined) return;
    // `info.frameId` is the frame the menu was opened in, and it is the whole
    // reason the narrower scopes work from here: it names the document holding
    // the element the user right-clicked (UC-003 A3). Chrome supplies no
    // *element* identifier, which is why the agent has to have seen the click
    // itself — DD-001's argument, restated.
    void startFill(operations, { tabId: tab.id, frameId: info.frameId }, scope, 'menu');
  });

  // FR-004: the toolbar reaches only "fill all inputs" — it has no cursor
  // position to derive a narrower scope from (BR-001-6). It is also the
  // zero-configuration path DD-007 leans on.
  browser.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void startFill(operations, { tabId: tab.id }, 'all-inputs', 'toolbar');
  });

  browser.tabs.onUpdated.addListener((tabId, changes) => {
    clearBadgeOnNavigation(tabId, changes.status ?? '');
  });

  // The `tab` here is the browser's own argument, not a polyfill's courtesy:
  // Chromium has passed it for years — `@wxt-dev/browser` is generated from
  // `@types/chrome`, which declares `(command, tab?)` — and Firefox added it in
  // 126, under NFR-016's floor of 128. Reading it costs no `tabs` permission,
  // which is the whole reason the shortcut path needs none (NFR-008).
  //
  // It is optional in the signature because a command *can* fire with no tab:
  // a `global` command fires with the browser unfocused. None of ours is
  // declared global (`wxt.config.ts`), so a shortcut only ever arrives with a
  // window focused and an active tab beneath it. The guard below stands anyway
  // — an absent tab leaves nothing to fill and nothing to put a badge on, so
  // returning is the only outcome available rather than a choice.
  browser.commands.onCommand.addListener((command, tab) => {
    const scope = COMMAND_SCOPES[command];
    if (scope === undefined || tab?.id === undefined) return;
    // No frame: a keyboard shortcut is not aimed at anything. The narrower
    // scopes go to the top frame, which resolves them from what is focused there
    // or — for the form scope with nothing focused — by widening (UC-002 A2).
    void startFill(operations, { tabId: tab.id }, scope, 'shortcut');
  });

  // The agent's half of the round trip: descriptors in, values out. Answered
  // with `sendResponse` and an explicit `return true`, which is the one form
  // both browsers agree on for an asynchronous reply. The arms live in the
  // modules that own them: the report question in `reporting`, everything about
  // a live operation in the registry.
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // The options page asking for the last report (DD-006). Checked before the
    // agent messages and answered only for our own pages: a content script
    // shares a process with a document we do not control, and the report spans
    // every frame — one frame's agent has no business reading another's.
    if (answerReportRequest(raw, sender, sendResponse)) return true;

    // `pong` and `accepted` are replies to something the background asked, not
    // messages it must act on — they arrive through `sendResponse`, not here.
    if (!isFromAgentMessage(raw) || raw.kind === 'pong' || raw.kind === 'accepted') return;

    // `joined` needs no answer, so it is handled without the channel.
    if (raw.kind === 'joined') {
      operations.joined(raw);
      return;
    }

    if (raw.kind === 'descriptors') {
      // `true` only when an answer was actually sent. Holding the channel open
      // without sending one stalls the agent's un-timed `await` until this
      // worker is evicted — the routine eviction-restart case would become a
      // half-minute silent hang instead of the `undefined` the agent reports
      // as `values-unavailable`. Same contract as `answerReportRequest`.
      return operations.descriptors(raw, sendResponse);
    }

    operations.report(raw);
  });

  trace('background ready');
});
