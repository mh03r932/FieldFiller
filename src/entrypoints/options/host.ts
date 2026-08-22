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
  /**
   * Replaces the whole configuration, and settles when the write has (UC-026).
   *
   * Separate from `save` because an import is the one operation that needs the
   * answer. `save` is optimistic and fire-and-forget: it announces a rejected
   * write and moves on, which is right for a checkbox and wrong for a
   * replacement — UC-026 A7 has to be able to say the import did not happen,
   * and a caller with no promise to wait on can only guess. Rejects after
   * announcing, so the failure is stated once and the caller still knows.
   */
  readonly replace: (settings: Settings) => Promise<void>;
  /**
   * Redraws every section from the current state (UC-026).
   *
   * Unconditional, unlike the render the page does when adopting another
   * writer's settings: that one skips whatever holds the focus, to keep a
   * settings change arriving mid-keystroke from eating the rest of them. An
   * import has no keystroke to protect — the user has just clicked a button
   * agreeing to replace everything, and every list on the page now describes a
   * configuration that is gone. Leaving one section showing it would be the
   * staleness that skip exists to trade *for*, with nothing bought.
   */
  readonly redraw: () => void;
};
