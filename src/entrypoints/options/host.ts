import type { Settings } from '@/lib/settings';

/**
 * What every section of the options page is given.
 *
 * One state, one writer, one live region — shared so that a section cannot
 * invent its own way to persist or to announce. `settings` is a function rather
 * than a value because the page adopts writes made elsewhere (UC-024): a section
 * that closed over the state it was built with would compute its next save from
 * a snapshot that is no longer what storage holds, which is the stale-closure
 * defect the rule editor was fixed for, one level up.
 */
export type OptionsHost = {
  readonly settings: () => Settings;
  /** Persists a whole settings state. Rejects are surfaced by the caller. */
  readonly save: (settings: Settings) => void;
  /** Announced politely, for changes a sighted user sees and nobody else would. */
  readonly announce: (text: string) => void;
};
