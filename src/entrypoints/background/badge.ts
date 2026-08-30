import { browser } from 'wxt/browser';
import { message } from '@/lib/platform/i18n';
import type { Exclusion } from './fills';

/**
 * Everything the toolbar badge shows (DD-006, UC-008, UC-017).
 *
 * One concern, one module: the badge is shared state between three writers —
 * a completed fill's count, a refused fill's dash, a standing exclusion mark —
 * and the generation counter below is what keeps them from erasing each other.
 * Extracted from the background entrypoint when it was split along that seam.
 */

/**
 * What the badge on each tab is currently showing, as a counter.
 *
 * A fill's badge reverts after a few seconds; an exclusion mark does not. Without
 * this, the revert timer armed by one fill erases whatever was put there
 * afterwards — fill a page, move to an excluded site inside the revert window,
 * and the "off" mark appears and then silently vanishes. The timer therefore
 * clears only what it set, which it checks by comparing this counter.
 *
 * Found by the scope harness rather than reasoned about: the mark was being set
 * correctly and read back empty.
 */
const badgeGeneration = new Map<number, number>();

function claimBadge(tabId: number): number {
  const next = (badgeGeneration.get(tabId) ?? 0) + 1;
  badgeGeneration.set(tabId, next);
  return next;
}

/**
 * Runs badge writes, and undoes them if the tab moved on while they were in
 * flight (UC-008 A5, BR-008-3).
 *
 * `claimBadge` bumps a generation and the `onUpdated` listener bumps it again on
 * every navigation, clearing the badge as it goes. That ordering was only half
 * honoured: the claim was taken and then never consulted, so a navigation
 * landing between two awaited writes cleared the badge and our next write put
 * the previous page's mark on the newly loaded one.
 *
 * Sub-millisecond, and the next fill re-evaluates from scratch — but the mark
 * claims to stand until the tab navigates, and a mark describing the page before
 * the one on screen is exactly the claim being broken. It matters most for the
 * exclusion mark, which is standing rather than reverted after three seconds:
 * a wrongly-placed `off` says a page is excluded that is not.
 */
async function whileCurrent(tabId: number, generation: number, writes: () => Promise<void>): Promise<void> {
  if (badgeGeneration.get(tabId) !== generation) return;
  await writes();
  if (badgeGeneration.get(tabId) === generation) return;

  await browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  await browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
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
export async function showBadge(
  tabId: number,
  text: string,
  colour: string,
  /** FR-078's "and it says that it stopped", where a count cannot say it. */
  title?: string,
): Promise<void> {
  const generation = claimBadge(tabId);
  try {
    await whileCurrent(tabId, generation, async () => {
      await browser.action.setBadgeBackgroundColor({ tabId, color: colour });
      await browser.action.setBadgeText({ tabId, text });
      if (title !== undefined) await browser.action.setTitle({ tabId, title });
    });
    setTimeout(() => {
      // Only if nothing has claimed the badge since. See `badgeGeneration`.
      if (badgeGeneration.get(tabId) !== generation) return;
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
      if (title !== undefined) void browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
    }, 3000);
  } catch {
    // A tab that closed mid-fill cannot show a badge. Not a fill failure.
  }
}

/**
 * Marks a tab as excluded (FR-038).
 *
 * Standing, unlike the count a completed fill leaves: a count is about something
 * that happened, and this is about something that will keep not happening. It is
 * cleared when the tab navigates (see the `onUpdated` listener in the
 * entrypoint), which needs the tab's identity and its loading state but never
 * its address (BR-008-3).
 */
export async function showExcluded(tabId: number, exclusion: Exclusion): Promise<void> {
  const generation = claimBadge(tabId);
  try {
    await whileCurrent(tabId, generation, async () => {
      await browser.action.setBadgeBackgroundColor({ tabId, color: '#6c737f' });
      await browser.action.setBadgeText({ tabId, text: 'off' });
      const title =
        exclusion.kind === 'pattern'
          ? message('resultExcluded', [exclusion.pattern])
          : message('resultExcludedUnreadable');
      await browser.action.setTitle({ tabId, title });
    });
  } catch {
    // A tab that closed cannot show a badge. Not a fill failure.
  }
}

/**
 * UC-008 A5, wired to `tabs.onUpdated` by the entrypoint. The mark says "this
 * tab is excluded", so it must not outlive the page it was about. The listener
 * is told a tab changed and what state it is in — never what it changed *to* —
 * which is all that clearing needs and is why it costs no permission
 * (BR-008-3).
 */
export function clearBadgeOnNavigation(tabId: number, status: string): void {
  if (status !== 'loading') return;
  claimBadge(tabId);
  void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  void browser.action.setTitle({ tabId, title: '' }).catch(() => undefined);
}
