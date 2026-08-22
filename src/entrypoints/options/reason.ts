/**
 * What to tell the user when something threw.
 *
 * Four copies of this expression appeared across the options page as the export
 * and import sections landed — two in `main.ts`, one in each section — all
 * formatting a caught `unknown` for the same live region, all in the same
 * words. One is enough, and it belongs somewhere neither section owns.
 *
 * The message is the thrown thing's own, never a diagnosis of ours: the page
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
