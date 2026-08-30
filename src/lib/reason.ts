/**
 * What to tell the user when something threw.
 *
 * Originally `src/entrypoints/options/reason.ts`, moved to `lib/` when the
 * Fake Filler migration turned out to carry a character-for-character copy —
 * one is enough, and it belongs somewhere no section owns.
 *
 * The message is the thrown thing's own, never a diagnosis of ours: the caller
 * cannot know why the browser refused a download or why storage rejected a
 * write, and a friendlier sentence invented here would be a guess presented as
 * a cause (NFR-020). The catalog string around it is what addresses the user.
 *
 * Deliberately not shared with `lib/rules/`, which formats caught errors too.
 * Those fall back to a *specific* sentence about the thing being parsed — "the
 * pattern could not be compiled" — because there the fallback names which
 * parser failed, and a generic `String(error)` would lose that.
 */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
