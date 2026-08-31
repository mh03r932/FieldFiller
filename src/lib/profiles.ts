import type { Profile, Rule } from './settings';
import { matchesGlob } from './globs';

/**
 * Which profile governs a page, and the operations that author one
 * (UC-007, UC-014..UC-017, FR-045..FR-047).
 *
 * A profile is a named rule set scoped to URLs. Resolution is a *list scan with
 * first match winning*, exactly as rule selection is, and for the same reason:
 * ND-2's argument is that a matcher the user cannot predict is a defect, so the
 * answer to "which profile applied?" has to be derivable by reading the list
 * top to bottom rather than by knowing a scoring rule.
 *
 * Pure and host-free. The URL arrives as a string; nothing here reads a tab
 * (NFR-015, BR-008-2).
 */

/**
 * The profile that governs `url`, or `undefined` for none.
 *
 * **One profile wins, not all that match.** Concatenating every matching
 * profile's rules would make the outcome depend on how many profiles happened to
 * overlap, which is the unpredictability FR-031 exists to remove — and UC-017
 * asks the system to *indicate* the active profile, which presumes there is one
 * to name. Overlap is resolved by position, so a user who wants a narrower
 * profile to win moves it above the broader one and can see that they have.
 *
 * A disabled profile is skipped rather than matched-and-ignored: it must not
 * shadow a lower profile that would otherwise apply, because "turn this one off
 * for now" plainly means the next one should get its turn.
 */
export function activeProfile(
  profiles: readonly Profile[],
  url: string,
): Profile | undefined {
  return profiles.find((profile) => profile.enabled && matchesProfile(profile, url));
}

/**
 * Whether any of a profile's patterns matches.
 *
 * A profile with **no** patterns matches nothing, rather than everything. Both
 * readings are defensible from an empty list alone and the difference is a
 * profile's rules silently applying to every page the user visits — so this
 * takes the reading whose failure is visible: the profile never applies, which
 * the editor flags as a problem while it is being written (UC-014 A2).
 *
 * It is also the reading consistent with the rest of the settings: a rule scoped
 * to no source matches nothing and is refused (UC-009 A6), rather than widening
 * to every source.
 */
export function matchesProfile(profile: Profile, url: string): boolean {
  return profile.urls.some((pattern) => pattern !== '' && matchesGlob(url, pattern));
}

/**
 * The rules a fill runs, in precedence order (UC-007, FR-031).
 *
 * The active profile's rules ahead of the global list, so a profile rule wins
 * over a global one by *position* rather than by a separate precedence pass.
 * That is what `compileRules` has documented since Phase 2 and what this
 * finally supplies: one ordered list, first match wins, and no second concept.
 *
 * The global rules are kept rather than replaced. A profile is a set of
 * additions for one application, not a mode — replacing would mean every profile
 * had to restate the user's general rules, and forgetting one would be invisible
 * until a field came out wrong on that application alone.
 */
export function rulesFor(
  profile: Profile | undefined,
  global: readonly Rule[],
): readonly Rule[] {
  return profile === undefined ? global : [...profile.rules, ...global];
}

/**
 * What to call a profile, or `undefined` if it has nothing to be called by.
 *
 * A label is optional (UC-014 step 2 starts one empty), so every surface that
 * names a profile needs the same fallback: the first pattern it matches on,
 * which is worse to read than a name and better than a blank. The wording for
 * the last resort is left to the caller, because this module is host-free and
 * has no `browser.i18n` (NFR-015, BR-008-2).
 *
 * Here rather than in the options page, which is where it lived until
 * 2026-08-18. The background had its own answer — `profile.label`, raw — so a
 * matching profile that had not been named yet reported as the empty string,
 * and the report folded that into "no profile matched this page" while the
 * profile's rules were in fact running at top precedence. That is a false
 * negative on the exact question FR-047 exists to answer, so both callers now
 * ask the same function.
 *
 * `undefined` is unreachable for a profile that *governs* a page: `activeProfile`
 * only returns one that matched, and `matchesProfile` ignores empty patterns, so
 * a nameless profile with nothing to fall back on can never be the active one.
 * It is a real answer for a profile being written, which is what the editor's
 * list has to render.
 */
export function profileName(profile: Profile): string | undefined {
  if (profile.label !== '') return profile.label;
  return profile.urls.find((pattern) => pattern !== '');
}

/** A new profile, in the state UC-014 step 2 describes. */
export function newProfile(id: string): Profile {
  return {
    id,
    label: '',
    enabled: true,
    // Matches nothing yet, so a profile being written cannot apply to a page
    // before the user has said which pages it is for. Starting it at `*` would
    // mean a half-written profile governing every tab.
    urls: [],
    rules: [],
  };
}
