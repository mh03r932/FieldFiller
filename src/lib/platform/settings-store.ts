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
 * **Propagation is not in this module because there is none to do** (BR-024-6).
 * Every fill instruction carries the settings it should be filled with, so a
 * page agent holds none between fills and none can go stale. "Live propagation"
 * (FR-051) is satisfied by there being nothing in the tab to update — the push
 * design this replaces has a failure mode it cannot have, where a throttled or
 * navigating tab misses the message and then fills with old settings, silently
 * and only sometimes.
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

/**
 * Writes a complete settings state (UC-024, NFR-021).
 *
 * Whole, never patched (BR-024-1): a partial update admits a stored combination
 * that no validation ever saw, which is exactly what NFR-021 exists to prevent.
 *
 * The candidate goes through `parseSettings` on the way *in*, and what that
 * returns is what gets written (BR-024-7). Validating with one function and
 * loading with another is how a user comes to see a rule saved and then find it
 * altered or gone on the next fill, with nothing to indicate why. Here the
 * reader is the validator, so a state that survives the write survives the read
 * by construction.
 *
 * The cache is not updated here. `onChanged` drops it and the next read
 * repopulates from storage, so storage stays the source of truth even for a
 * write this context made itself (BR-024-3) — and a write that silently failed
 * cannot leave memory claiming otherwise.
 */
export async function saveSettings(candidate: Settings): Promise<void> {
  const normalised = parseSettings(candidate);
  await browser.storage.local.set({ [STORAGE_KEY]: normalised });
}
