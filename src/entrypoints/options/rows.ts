import { message } from '@/lib/platform/i18n';
import { focusIn } from './controls';
import type { OptionsHost } from './host';

/**
 * Rows that address their entry by position, and the guard that keeps them
 * honest across a foreign write (UC-024, BR-024-3).
 *
 * Domain exclusions, field exclusions and a profile's address patterns are
 * ordered lists of values with no identity of their own — deliberately, because
 * two identical patterns are a redundant configuration rather than an illegal
 * one and removing "the entry equal to this" would take the first of them
 * however far down the list the user clicked (`lib/lists`). So a row is drawn
 * knowing only *where* its entry sits, and its handlers write through that
 * index for as long as the row is on screen.
 *
 * Which is exactly as long as the section is not re-rendered — and the page
 * deliberately skips re-rendering a section that holds the focus, or that holds
 * an open profile. Those are the moments the user is most likely to be typing
 * into one of these rows, so the skip window and the danger window are the same
 * window: another options page shortens or reorders the list, this page adopts
 * it into memory, and the next keystroke writes through an index that now names
 * somebody else's entry. `replaceAt` edits the wrong row, `removeAt` deletes the
 * wrong row, and an index past the end quietly writes nothing at all while the
 * box on screen goes on showing what was typed.
 *
 * The guard is a comparison rather than an identifier: the row remembers the
 * value it was drawn from and every value it has written since, and refuses to
 * act when the list no longer holds that value at that index. It cannot tell a
 * shifted row from one the other writer happened to give the same text, and does
 * not need to — the two are indistinguishable to the user as well.
 */
export type PositionalRow<T> = {
  /**
   * The entry this row still describes, or `undefined` when the list has moved
   * under it.
   */
  readonly entry: () => T | undefined;
  /** Records what this row just wrote, so its next edit still recognises it. */
  readonly wrote: (value: T) => void;
};

export function rowAt<T>(read: () => readonly T[], at: number, drawn: T): PositionalRow<T> {
  let held = drawn;
  return {
    entry: () => {
      const entry = read()[at];
      if (entry === undefined) return undefined;
      // Structural, because a field exclusion is a mode and a pattern rather
      // than a string. The same comparison the page uses to recognise its own
      // writes coming back out of storage, for the same reason: these are plain
      // data with no reference identity to rely on, since every save round-trips
      // through the parser and returns fresh objects.
      return entry === held || JSON.stringify(entry) === JSON.stringify(held) ? entry : undefined;
    },
    wrote: (value) => {
      held = value;
    },
  };
}

/**
 * What a row does when it finds the list moved under it.
 *
 * Nothing is written — the edit was aimed at an entry that is no longer there,
 * and applying it anyway is the defect. The section is redrawn instead, because
 * the alternative is the silent discard: the box keeps showing what was typed
 * while storage holds something else, which is the one outcome UC-024 A2's
 * reasoning rules out for a failed save and which applies here for the same
 * reason. The redraw costs the caret, so it is announced, and the focus is put
 * somewhere real rather than dropped on `<body>`.
 */
export function rowMovedUnderYou(
  host: OptionsHost,
  into: HTMLElement,
  redraw: () => void,
  focus: string,
): void {
  host.announce(message('listChangedElsewhere'));
  redraw();
  focusIn(into, focus);
}
