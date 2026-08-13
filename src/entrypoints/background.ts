import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';

/**
 * Background context — MV3 service worker on Chromium, event page on Firefox
 * (C-003, absorbed by WXT from this one file).
 *
 * Phase 0 registers every trigger channel and handles none of them. The point is
 * that the manifest and the registrations are exercised by a real browser now,
 * while they are cheap to change: an illegal command key or a context-menu
 * property one browser rejects fails at load, not at review time. Phase 1 gives
 * these handlers a fill to dispatch.
 */

/** The three fill scopes (UC-001, UC-002, UC-003). */
type FillScope = 'all-inputs' | 'current-form' | 'selected-input';

/**
 * Context menu ids. Kept identical to the command names so a scope has one
 * identity across both channels — BR-001-6: a channel chooses which scopes it
 * can reach and nothing else, so the two must not be able to drift apart.
 */
const MENU_ITEMS: ReadonlyArray<{ id: FillScope; titleMessage: MessageKey }> = [
  { id: 'all-inputs', titleMessage: 'menuFillAllInputs' },
  { id: 'current-form', titleMessage: 'menuFillCurrentForm' },
  { id: 'selected-input', titleMessage: 'menuFillSelectedInput' },
];

/** Maps a manifest command name onto its scope. */
const COMMAND_SCOPES: Readonly<Record<string, FillScope>> = {
  'fill-all-inputs': 'all-inputs',
  'fill-current-form': 'current-form',
  'fill-selected-input': 'selected-input',
};

/**
 * Development-only tracing. Never reaches a release build, and never writes to a
 * *page's* console in any build — D5 leaked generated passwords that way.
 */
function trace(text: string): void {
  // `COMMAND` is statically replaced at build time, so this branch and its string
  // are eliminated from a production bundle rather than merely skipped.
  if (import.meta.env.COMMAND === 'serve') {
    console.debug(`[fieldfiller] ${text}`);
  }
}

/** Phase 1 replaces this with the fill dispatch. */
function notYetImplemented(scope: FillScope, channel: string): void {
  trace(`${channel} → fill ${scope} (not implemented)`);
}

export default defineBackground(() => {
  // Menus survive across service-worker restarts, so creating them on every
  // startup would duplicate them. `onInstalled` is the only correct hook.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      for (const item of MENU_ITEMS) {
        browser.contextMenus.create({
          id: item.id,
          title: message(item.titleMessage),
          // `editable` would be the natural filter for the selected-input
          // scope, but the other two scopes apply anywhere on a page, so the
          // contexts stay broad and the scope decides what it can reach.
          contexts: ['page', 'editable'],
        });
      }
    });
  });

  browser.contextMenus.onClicked.addListener((info) => {
    const scope = MENU_ITEMS.find((item) => item.id === info.menuItemId)?.id;
    if (scope !== undefined) notYetImplemented(scope, 'context menu');
  });

  // FR-004: the toolbar reaches only "fill all inputs" — it has no cursor
  // position to derive a narrower scope from (BR-001-6). It is also the
  // zero-configuration path DD-007 leans on, so it must never be the channel
  // that needs setting up.
  browser.action.onClicked.addListener(() => {
    notYetImplemented('all-inputs', 'toolbar');
  });

  // FR-005 / DD-007. `fill-selected-input` ships unbound and still appears
  // here: the listener has to exist for the day the user binds it themselves.
  browser.commands.onCommand.addListener((command) => {
    const scope = COMMAND_SCOPES[command];
    if (scope !== undefined) notYetImplemented(scope, `command ${command}`);
  });

  trace('background ready');
});
