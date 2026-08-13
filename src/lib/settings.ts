import type { AgentSettings } from './protocol';

/**
 * The settings state and its defaults.
 *
 * Platform-free: this module knows what settings *are*, not where they live.
 * Reading and writing is `lib/platform/settings-store.ts`, which is what keeps
 * the engine testable without a browser host (NFR-015).
 *
 * Deliberately small. The full schema — rules as a discriminated union on
 * generator type, profiles, exclusions — is Phase 4 work and depends on DD-005,
 * which is still open. Guessing at it now would mean writing the migration
 * ladder against a shape that has not been decided (implementation plan,
 * ordering principle 4).
 */

export type Settings = {
  /**
   * Schema version. Present from the first release even though there is nothing
   * to migrate yet: a stored state with no version is indistinguishable from
   * version 1, and the first migration is the one that discovers this.
   */
  readonly version: 1;

  /** UC-004 A8. Off means values are written without the interaction sequence. */
  readonly dispatchEvents: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  dispatchEvents: true,
};

/**
 * The subset an agent needs (BR-024-4).
 *
 * A function rather than a spread so that adding a setting the background alone
 * uses cannot leak into the page by default — the boundary has to be crossed
 * deliberately, one field at a time.
 */
export function agentSettings(settings: Settings): AgentSettings {
  return { dispatchEvents: settings.dispatchEvents };
}

/**
 * Coerces stored data into a valid settings state.
 *
 * Storage is the source of truth (BR-024-3), but it is not trustworthy: it may
 * hold a state written by an older version, or nothing at all on first run.
 * Unknown or malformed input falls back to defaults per field rather than
 * rejecting the whole state, so one bad key cannot leave the user with no
 * settings at all.
 */
export function parseSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;

  const candidate = stored as Partial<Record<keyof Settings, unknown>>;
  return {
    version: 1,
    dispatchEvents:
      typeof candidate.dispatchEvents === 'boolean'
        ? candidate.dispatchEvents
        : DEFAULT_SETTINGS.dispatchEvents,
  };
}
