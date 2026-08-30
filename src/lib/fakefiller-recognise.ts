/**
 * Recognising a Fake Filler backup on sight (UC-027 step 3, BR-027-2).
 *
 * Read by two callers that must never disagree about what a Fake Filler
 * backup is: the migration itself, and the settings importer's refusal.
 * The importer refuses such a file and points here (UC-026 A5); a backup
 * the importer called Fake Filler's that the migration then refused to
 * recognise would be two screens sending the user to each other — so the
 * recognition lives once, in the smallest module either of them can import
 * without a cycle.
 *
 * **The key set is the reference's documented schema, read from
 * `docs/FAKEFILLER_RESEARCH.md` §2.2 (commit `36daf90`, the research BR-027-2
 * names), not recalled from memory.** That is the whole of BR-027-2's
 * second paragraph: a converter written from memory guesses at key names,
 * and a guessed key name is inert when the guess is wrong and worse than
 * inert when a name happens to be shared. Only the eleven keys ours cannot
 * be confused with are listed; `version` and `profiles` are omitted because
 * our own schema carries both, and recognition must not fire on a file that
 * might be ours.
 */

/**
 * The reference's root keys that ours never carries.
 *
 * Strongest first is a comment, not an ordering: the check is `some`, and
 * any one of these distinguishes a backup from every file this extension
 * writes. `fields` is the one that does the work in practice — it is the
 * reference's whole custom-field list, and our schema says `rules`.
 */
const UNAMBIGUOUS_KEYS: ReadonlySet<string> = new Set([
  'fields',
  'fieldMatchSettings',
  'ignoredFields',
  'agreeTermsFields',
  'confirmFields',
  'defaultMaxLength',
  'enableContextMenu',
  'ignoreFieldsWithContent',
  'ignoreHiddenFields',
  'passwordSettings',
  'triggerClickEvents',
]);

/**
 * Whether a parsed value carries any key a Fake Filler backup has and ours
 * does not (step 3, A1's trigger).
 *
 * A `Set` of keys is the whole test because there is no shape to check
 * before recognition has decided what the file is: the reference's own
 * export writes Base64-encoded JSON carrying exactly these names, and a
 * file someone renamed to `.json` carries the same names. Recognition on
 * names rather than on "failed to parse as ours" is what makes the mirror
 * direction honest too — a file of ours that happens to share `version`
 * with the reference is not mistaken for a backup, which is A1's second
 * flow and UC-026 A5's mirror.
 */
export function looksLikeFakeFiller(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  return Object.keys(parsed).some((key) => UNAMBIGUOUS_KEYS.has(key));
}

/**
 * The reference's export transport: standard Base64, decoded (UC-027 step 2).
 *
 * Tolerant about padding and whitespace, because hand-copied and re-saved
 * `.txt` files are the transport's reality; strict about everything else,
 * because almost any text *partially* decodes as Base64 and the caller's
 * JSON parse is what actually decides. Returns `undefined` for anything
 * that cannot be Base64 at all.
 *
 * Shared by the migration and the importer's refusal, for the reason the
 * key set above is: a migrant who points the *import* section at their
 * backup must meet the pointer to the migration, and a Base64 `.txt` is
 * what the reference actually downloads — a recognition that only ran on
 * JSON would never fire for the real artefact.
 */
export function decodeBackupTransport(text: string): string | undefined {
  if (text.length === 0 || !/^[A-Za-z0-9+/=\s]+$/.test(text)) return undefined;

  const compact = text.replace(/\s+/g, '');
  const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}
