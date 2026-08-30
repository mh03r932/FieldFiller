import { browser } from 'wxt/browser';
import { message, type MessageKey } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import type { FillScope } from '@/lib/protocol';
import { trace } from './trace';

/**
 * The context menu (UC-023, FR-050): registration and reconciliation.
 *
 * Extracted from the background entrypoint when it was split, because it is
 * the one responsibility that is *browser state* rather than fill state — the
 * menu outlives the worker — and its reconciliation is a self-contained loop:
 * read the setting, clear, rebuild.
 */

export const MENU_ITEMS: ReadonlyArray<{ id: FillScope; titleMessage: MessageKey }> = [
  { id: 'all-inputs', titleMessage: 'menuFillAllInputs' },
  { id: 'current-form', titleMessage: 'menuFillCurrentForm' },
  { id: 'selected-input', titleMessage: 'menuFillSelectedInput' },
];

/**
 * Brings the context menu into agreement with the setting (UC-023, FR-050).
 *
 * Always `removeAll` first, whichever way the setting went. The menu is browser
 * state that outlives this context, so "create the three entries" is only
 * idempotent if what was there is cleared — and an MV3 worker is restarted by
 * events often enough that a second registration is the ordinary case rather
 * than the exception. Duplicating them is not a cosmetic fault: `create` fails
 * on a duplicate id — silently, since it neither throws nor rejects — which
 * would leave the menu half-built with nothing to say so.
 *
 * Called from `onInstalled`, from a settings change, and on every worker start,
 * so the menu matches the setting at the first right-click after any of them —
 * which is BR-023-4's "without a reload" as it actually presents to a user.
 */
export async function syncContextMenus(): Promise<void> {
  try {
    const { triggers } = await getSettings();
    await browser.contextMenus.removeAll();
    if (!triggers.contextMenu) {
      trace('context menu disabled by settings; entries removed');
      return;
    }
    for (const item of MENU_ITEMS) {
      // Not awaited, and not because it was forgotten: `create` is the one
      // method in this namespace that returns the new id rather than a promise,
      // in both browsers. There is no rejection for the `catch` below to
      // receive, so a failure is reported the only way this call reports one —
      // through `runtime.lastError`, read in the callback, where the call that
      // set it is still identifiable. Unread, a failed entry is simply absent
      // from the menu with nothing said anywhere.
      browser.contextMenus.create(
        {
          id: item.id,
          title: message(item.titleMessage),
          contexts: ['page', 'editable'],
        },
        () => {
          const failure = browser.runtime.lastError;
          if (failure === undefined) return;
          trace(`context menu entry "${item.id}" was not created: ${failure.message ?? 'no reason given'}`);
        },
      );
    }
    trace(`registered ${MENU_ITEMS.length} context menu entries`);
  } catch (error) {
    // `onInstalled` has no error path, and an unhandled rejection here would be
    // reported as an extension error naming no channel. It covers what actually
    // rejects: `getSettings` and `removeAll`, both promise-returning in both
    // browsers. `create` is not one of them — it returns an id and reports
    // through `runtime.lastError`, which is why it is handled at the call rather
    // than here (NFR-017).
    //
    // A failure here leaves the menu as it was, which is UC-023 A2's failure
    // postcondition: the previous trigger configuration remains in force. The
    // options page reports the *storage* write, which is the half of the change
    // the user can be told about honestly — this half has no surface, and
    // `docs/use_cases/UC-023.md` A2 says so rather than claiming otherwise.
    trace(`context menu sync failed: ${String(error)}`);
  }
}
