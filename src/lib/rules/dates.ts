import type { Random } from '../persona/persona';

/**
 * The date format grammar for FR-019's `date` generator.
 *
 * Ours rather than the reference's, which uses moment.js format strings — a
 * library deprecated by its own maintainers, whose grammar has escape rules
 * (`[literal]`) and locale-dependent tokens that nothing here needs. PD-002
 * reserves exactly this right, and UC-027's importer translates the tokens it
 * can and reports the rest.
 *
 * Seven tokens, each at least two characters long:
 *
 *     YYYY  four-digit year      MM  two-digit month    DD  two-digit day
 *     YY    two-digit year       MMM three-letter month
 *     HH    hours (24)           mm  minutes            ss  seconds
 *
 * Everything else passes through as a literal. Tokens are two characters or
 * more precisely so that single letters in a format — the `T` in an ISO
 * timestamp, an `at` between date and time — need no escaping.
 *
 * `MMM` is English-only, and that is a stated limitation rather than an
 * oversight: a localised month name would need the locale of the *page* being
 * filled, which the generator does not have and should not guess.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Longest first, so `MMM` is never read as `MM` followed by a literal `M`. */
const TOKENS = /YYYY|MMM|YY|MM|DD|HH|mm|ss/g;

/**
 * What `TOKENS` can hand the substitution callback.
 *
 * Written out so the switch below can be exhaustive and carry no `default`.
 * The arm it used to carry — `return token` — was unreachable by
 * construction (nothing outside the alternation reaches that callback), which
 * made it the one uncovered line in this module and, worse, a silent licence
 * to add a ninth token to the regex without adding its case: the new token
 * would have echoed itself into every generated date instead of failing to
 * compile. The union and the alternation have to be edited together now.
 */
type DateToken = 'YYYY' | 'MMM' | 'YY' | 'MM' | 'DD' | 'HH' | 'mm' | 'ss';

export function formatDate(date: Date, format: string): string {
  TOKENS.lastIndex = 0;
  return format.replace(TOKENS, (token) => {
    switch (token as DateToken) {
      case 'YYYY':
        return String(date.getUTCFullYear());
      case 'YY':
        return pad(date.getUTCFullYear() % 100);
      case 'MMM':
        return MONTHS[date.getUTCMonth()] ?? '';
      case 'MM':
        return pad(date.getUTCMonth() + 1);
      case 'DD':
        return pad(date.getUTCDate());
      case 'HH':
        return pad(date.getUTCHours());
      case 'mm':
        return pad(date.getUTCMinutes());
      case 'ss':
        return pad(date.getUTCSeconds());
    }
  });
}

/** Whether a format string contains at least one token to substitute. */
export function hasDateToken(format: string): boolean {
  TOKENS.lastIndex = 0;
  return TOKENS.test(format);
}

/**
 * What `formatDate` would substitute in an arbitrary piece of text, and what
 * remains of the text with none of it.
 *
 * The grammar has no escape: a token matches *anywhere*, including inside
 * what an author meant as a literal. `hasDateToken` answers the save-time
 * question (is there anything to substitute at all); this answers the
 * translation-time one — a moment-style `[literal]` carrying `mm` inside it
 * cannot be represented in this grammar, and the caller needs to know both
 * which characters would substitute and what is safely emittable. One regex,
 * one alternation order, owned here so the answer cannot drift from what
 * `formatDate` actually does.
 */
export function withoutDateTokens(
  text: string,
): { readonly text: string; readonly tokens: readonly string[] } {
  const tokens = text.match(TOKENS) ?? [];
  return { text: text.replace(TOKENS, ''), tokens };
}

/**
 * A date drawn uniformly between two ISO bounds, inclusive.
 *
 * UTC throughout. A date generated in local time drifts by a day either side of
 * midnight depending on where the machine is, which turns a deterministic seed
 * into a flaky test — and the whole point of `seededRandom` is that it does not.
 */
export function randomDate(from: string, to: string, random: Random): Date {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return new Date(0);

  const [low, high] = start <= end ? [start, end] : [end, start];
  return new Date(low + Math.floor(random() * (high - low + 1)));
}

/** Whether an ISO `YYYY-MM-DD` string names a real date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  // `Date.parse` accepts 2026-02-31 and rolls it forward, so the round trip is
  // what actually rejects a day that does not exist. It is also engine-dependent
  // in the other direction — the tightened parsing spec rejects what this V8
  // rolls — which is why the round trip rather than the parse is the answer:
  // it is false on both behaviours.
  //
  // `Temporal.PlainDate.from(value, { overflow: 'reject' })` throws on exactly
  // this input by specification, and would delete both the round trip and the
  // paragraph above it. It is deferred, not overlooked: NFR-016's floors
  // (Chrome 120, Firefox 128) predate `Temporal` in both engines, and the
  // implementation plan's Deferred table records the decision and what has to
  // change for it to be revisited.
  return new Date(parsed).toISOString().startsWith(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
