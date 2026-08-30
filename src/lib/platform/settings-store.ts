import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../settings';
import { reason } from '../reason';

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

/**
 * Storage, read now and without a net (UC-025 step 2).
 *
 * `getSettings` below answers a failed read with the defaults, and for a fill
 * that is right. For an export it is the worst thing it could do: a file of
 * defaults, serialised and named like any other, is the one failure UC-025
 * cannot report after the fact — it looks entirely correct, and the machine it
 * is imported onto loses the configuration it was supposed to receive. So the
 * export path reads through here, where a rejection stays a rejection and A4
 * has something to catch.
 *
 * Uncached in both directions. It does not answer from the cache, because a
 * cache holding the defaults from an earlier failed read is exactly what a
 * strict read exists to see past; and it does not fill the cache, because that
 * would make the fill path's state depend on whether anyone had exported.
 */
export async function readSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return parseSettings(stored[STORAGE_KEY]);
}

export async function getSettings(): Promise<Settings> {
  if (cached !== undefined) return cached;

  try {
    cached = await readSettings();
  } catch (error) {
    // Storage being unavailable must not stop a fill. Defaults are a complete,
    // self-consistent state, and refusing to fill because a preference could not
    // be read would fail the user over something they never configured.
    //
    // Loudly, though, because this used to be indistinguishable from "the user
    // changed nothing": someone whose storage read rejects gets a defaults fill
    // with no record anywhere that anything was refused (NFR-020 — a failure
    // should name its own cause). A `warn` rather than a trace because it asks
    // the one person reading the console to act.
    console.warn(`[fieldfiller] settings could not be read; using defaults (${reason(error)})`);
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
 * That is a claim about *shape*, and nothing more. `parseSettings` coerces a
 * state into the current types; it does not apply FR-070, so a rule whose regex
 * will not compile is well-shaped and passes through here untouched. Keeping
 * invalid rules out of storage is the rule editor's doing — it commits only what
 * `validateRule` accepts — which means a writer that is not the editor has to
 * validate for itself. There is one, the importer, and it does: `analyseImport`
 * puts every rule it reads out of a file through the same function and stores
 * what is left (BR-026-8). It went a while without, which is what this paragraph
 * was warning about. BR-024-7 states the boundary and why filtering here was
 * considered and declined.
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
