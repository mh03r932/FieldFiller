import { DEFAULT_SETTINGS, parseSettings, type Settings } from './settings';

/**
 * UC-028 — the shipped defaults, back over everything (FR-057).
 *
 * The write itself is nothing: `DEFAULT_SETTINGS` handed to the page's
 * single-replacement path, the same one an import uses (BR-026-6's argument,
 * so a failed restore leaves the previous configuration whole — BR-024-2).
 * What the use case adds is the *confirmation*, and the confirmation is
 * numbers: how many rules, profiles and exclusions are about to be discarded,
 * and whether anything would change at all (BR-028-2, A2). That is what lives
 * here, platform-free, so the counts on screen and the state they describe
 * cannot drift apart the way a second copy of either would.
 *
 * The restore is a replacement and never a merge (BR-028-1), which is why
 * there is no "keep my rules" variant anywhere in this module: a merge would
 * produce a rule order nobody chose, and precedence is behaviour (FR-031). The
 * screen says what is discarded and offers export as the way back — before the
 * write, not after (BR-028-5).
 */

/** What a restore discards, in the counts the confirmation names (BR-028-2). */
export type RestoreLoss = {
  readonly rules: number;
  readonly profiles: number;
  readonly fieldExclusions: number;
  readonly domainExclusions: number;
};

/**
 * The four counts, in the shape the import preview established.
 *
 * `rules` is the global list and a profile's rules are inside `profiles`,
 * matching how `importPlanSummary` words its two sides: a profile carries its
 * rules, and "3 profiles" already says what losing them costs. Splitting the
 * counts the other way — global plus scoped, profiles separately — would give
 * the confirmation a fifth number to read and no sentence it enables that the
 * four do not.
 *
 * Counted on the state *after* the parser, for `isDefaultConfiguration`'s
 * reason below: an entry the parser drops — a rule whose pattern has not been
 * typed yet, a blank exclusion row — is discarded by any write this page can
 * make, not only by the restore, so counting it put "1 rule" on a screen the
 * line beside it was about to contradict with "this changes nothing". The
 * counts and the already-defaults answer are one fact about one state, and
 * they are normalised in the same place so they cannot disagree about what
 * that state is.
 */
export function restoreLoss(settings: Settings): RestoreLoss {
  const normal = parseSettings(settings);
  return {
    rules: normal.rules.length,
    profiles: normal.profiles.length,
    fieldExclusions: normal.exclusions.fields.length,
    domainExclusions: normal.exclusions.domains.length,
  };
}

/**
 * Whether a state already *is* the shipped one (UC-028 A2).
 *
 * Both sides through the parser before the comparison, for the reason the
 * options page's own storage listener does this (BR-024-3): the state in the
 * page's memory is un-normalised, and comparing it raw against
 * `DEFAULT_SETTINGS` would call every normalisation a difference. A rule with
 * an empty pattern — the state between adding a rule and typing its pattern —
 * is dropped by the parser, so a state holding one parses to the defaults and
 * *is* one for every purpose a fill has. Answering "nothing to discard" about
 * it is the truth, not a rounding-off.
 *
 * JSON rather than a deep-equal helper because the page already compares
 * settings this way for the same question, and two comparison disciplines for
 * one job is how they come to disagree about what "equal" means. That includes
 * the right-hand side: `JSON.stringify` is key-order sensitive, so comparing
 * parser output against the literal's own order answers a question about who
 * wrote each object rather than what either of them says. Both sides go through
 * the parser, exactly as `main.ts`'s storage listener does (BR-024-3), so the
 * comparison is between two states in the same normal form.
 */
export function isDefaultConfiguration(settings: Settings): boolean {
  return (
    JSON.stringify(parseSettings(settings)) === JSON.stringify(parseSettings(DEFAULT_SETTINGS))
  );
}
