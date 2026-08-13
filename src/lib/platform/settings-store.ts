import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../settings';

/**
 * Reads settings from storage and keeps them in memory (UC-024, ND-17, NFR-026).
 *
 * The reference reads storage on every page's `getOptions` message — a storage
 * round trip per page load, per frame. This caches in the background context and
 * invalidates on write, so the cost is one read per settings change rather than
 * one per frame.
 *
 * Storage is the source of truth and memory is derived (BR-024-3). The cache is
 * never written to independently: it is populated from storage and dropped when
 * storage changes, so on any doubt — a restart, a change from another context —
 * storage wins.
 *
 * Reads only, for now. Writing, validation, propagation to open tabs and the
 * debounce (BR-024-7) arrive in Phase 4 with the settings UI that needs them.
 */

const STORAGE_KEY = 'settings';

let cached: Settings | undefined;

export async function getSettings(): Promise<Settings> {
  if (cached !== undefined) return cached;

  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    cached = parseSettings(stored[STORAGE_KEY]);
  } catch {
    // Storage being unavailable must not stop a fill. Defaults are a complete,
    // self-consistent state, and refusing to fill because a preference could not
    // be read would fail the user over something they never configured.
    cached = DEFAULT_SETTINGS;
  }
  return cached;
}

/**
 * Drops the cache when storage changes.
 *
 * Registered at module load rather than lazily: an MV3 background is restarted
 * by events, and a listener attached only after the first read would miss a
 * change written while the context was down.
 */
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && STORAGE_KEY in changes) cached = undefined;
});
