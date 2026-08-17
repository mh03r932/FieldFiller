/**
 * List operations as values, for every ordered list the settings hold.
 *
 * Extracted from `exclusions.ts` when profiles arrived and needed the same four
 * (UC-014..UC-016). They are three lines each and duplicating them would be
 * cheaper to write than to keep true — the interesting one is `moveAt`, whose
 * end-of-list behaviour is a decision rather than an implementation detail.
 *
 * Pure and host-free, so the behaviour of every list screen is assertable
 * without a DOM (NFR-015). The screens render and listen.
 */

export function appendAt<T>(items: readonly T[], item: T): readonly T[] {
  return [...items, item];
}

export function replaceAt<T>(items: readonly T[], at: number, item: T): readonly T[] {
  return items.map((existing, index) => (index === at ? item : existing));
}

/**
 * Removes one entry by position.
 *
 * By index rather than by value, because these lists hold no identifiers of
 * their own and can hold duplicates: two identical patterns are a redundant
 * configuration rather than an illegal one, and removing "the entry equal to
 * this" would take the first of them however far down the list the user clicked.
 */
export function removeAt<T>(items: readonly T[], at: number): readonly T[] {
  return items.filter((_, index) => index !== at);
}

/**
 * Moves one entry one place.
 *
 * Returns the list unchanged at either end rather than wrapping, which is
 * `moveRule`'s rule and for the same reason: an entry that silently jumped from
 * first to last would rewrite the precedence of every entry between them.
 */
export function moveAt<T>(items: readonly T[], at: number, direction: -1 | 1): readonly T[] {
  const to = at + direction;
  if (at < 0 || at >= items.length || to < 0 || to >= items.length) return items;

  const moved = [...items];
  const [item] = moved.splice(at, 1);
  moved.splice(to, 0, item as T);
  return moved;
}
