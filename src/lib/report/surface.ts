import type {
  CapReason,
  ControlKind,
  FieldDescriptor,
  FieldReportEntry,
  FillReport,
  FillScope,
  FrameId,
  FrameReport,
  OutcomeCounts,
} from '../protocol';

/**
 * The per-control fill report (DD-006, FR-009, FR-069).
 *
 * A badge carries a count and a tooltip carries a sentence. Neither can answer
 * *why did this field get that value*, which is what FR-069 exists for and what
 * a user debugging an unexpected fill actually needs. That answer needs a row
 * per control, and a row per control needs somewhere with room — the options
 * page, per DD-006's layering.
 *
 * ## What this holds, and for how long
 *
 * A row is only useful if it names the field the way the user sees it, so these
 * rows carry the control's **identity** — its label, or failing that its
 * placeholder, name or id. That is page-derived data, and NFR-010 and NFR-030
 * bound what may happen to it:
 *
 *   · it is never written to storage, in any form, for any duration;
 *   · it never leaves the background context except to the extension's own
 *     options page, in response to that page asking;
 *   · exactly one fill's worth is held, replaced when the next fill begins;
 *   · it dies with the background context, which is evicted routinely.
 *
 * Identity already crosses into the background on every fill — it is most of a
 * descriptor, and matching cannot happen without it. What is new here is holding
 * it *after* the fill rather than discarding it at the end, and NFR-030 was
 * revised in the same change rather than quietly reinterpreted.
 *
 * A control's **value** is not held, and is not available to hold: descriptors
 * have never carried one (BR-004-10), and provenance describes how a value was
 * chosen rather than what it was.
 *
 * This module is host-free so it can be tested without an extension (NFR-015).
 * It produces structure; the background and the options page do the wording.
 */


/**
 * What the background remembers about the controls a frame has described.
 *
 * Keyed by frame *and* ref, because a ref is only unique within the frame that
 * issued it — two frames both start at zero, and a flat map would let one
 * frame's fields overwrite another's.
 */
export type FieldNotes = Map<string, { identity: string; kind: ControlKind }>;

export function noteKey(frame: FrameId, ref: number): string {
  return `${frame}#${String(ref)}`;
}

/**
 * Records what a batch of descriptors was, for the report.
 *
 * Called on every batch, so a control described again in a later pass (UC-034)
 * overwrites its earlier note — the page may have relabelled or replaced it, and
 * the report should say what it was when the fill ended.
 */
export function noteDescriptors(
  notes: FieldNotes,
  frame: FrameId,
  descriptors: readonly FieldDescriptor[],
): void {
  for (const descriptor of descriptors) {
    notes.set(noteKey(frame, descriptor.ref), {
      identity: identityOf(descriptor),
      kind: descriptor.kind,
    });
  }
}

/**
 * How to name this control to a person.
 *
 * Ordered by how close each source is to what the user actually reads on the
 * page: the label is what sits beside the field, and `name` or `id` are what the
 * developer called it — useful, but not what the user sees. `className` is never
 * used, because it identifies a style and not a field.
 */
export function identityOf(descriptor: FieldDescriptor): string {
  const { label, ariaLabel, placeholder, name, id } = descriptor.sources;
  return first(label, ariaLabel, placeholder, name, id) ?? `${descriptor.kind} field`;
}

function first(...candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed !== '') return trimmed;
  }
  return undefined;
}

/**
 * One frame's outcomes, joined to what that frame described.
 *
 * An outcome with no matching note still produces a row. That combination means
 * the agent reported a control it never described — which should not happen, and
 * is exactly why it is shown rather than dropped: a silently missing row is how
 * a reporting bug stays invisible (NFR-020).
 */
export function fieldsFromReport(notes: FieldNotes, report: FrameReport): FieldReportEntry[] {
  return report.outcomes.map((outcome) => {
    const note = notes.get(noteKey(report.frame, outcome.ref));
    const detail =
      outcome.status === 'filled'
        ? outcome.provenance
        : outcome.status === 'skipped'
          ? outcome.reason
          : outcome.cause;

    return {
      frame: report.frame,
      ref: outcome.ref,
      identity: note?.identity ?? 'unknown field',
      kind: note?.kind ?? 'text',
      status: outcome.status,
      detail,
    };
  });
}

/**
 * Every catalog key the result sentence can use.
 *
 * Named here, where the sentence is built, but resolved by the caller. That
 * split is what lets this module stay host-free while still being the only place
 * that decides *which* sentence a result gets — and because the background
 * passes its own catalog-typed lookup, a key listed here that nobody added to
 * `messages.json` is a compile error rather than a blank tooltip (NFR-018).
 */
export type ResultMessageKey =
  | 'resultScopeAllInputs'
  | 'resultScopeCurrentForm'
  | 'resultScopeSelectedInput'
  | 'resultSettled'
  | 'resultCapped'
  | 'resultCapUserInput'
  | 'resultCapPassCap'
  | 'resultCapTimeBudget'
  | 'resultCapValuesUnavailable'
  | 'resultRulesSkipped';

export type Translate = (key: ResultMessageKey, substitutions?: readonly string[]) => string;

/**
 * The whole sentence the tooltip carries (DD-006).
 *
 * All three facts, in the user's own language: which scope ran, how many fields
 * were filled, and whether the fill settled or stopped. The scope half is why
 * this exists — DD-008 made the scope inferable three ways, and "6 filled" reads
 * identically for a form and for a whole page.
 *
 * A rule that could not run is appended rather than given its own surface,
 * because it is a fact about the configuration rather than about this page, and
 * DD-006 gave the transient surfaces no room for a fourth fact (DD-005).
 */
export function resultSentence(report: FillReport, translate: Translate): string {
  const scope = translate(scopeKey(report.scope));
  const filled = String(report.counts.filled);

  const sentence =
    report.capped === undefined
      ? translate('resultSettled', [filled, scope])
      : translate('resultCapped', [
          filled,
          scope,
          String(report.stale),
          translate(capKey(report.capped)),
        ]);

  if (report.skippedRules.length === 0) return sentence;
  return `${sentence} ${translate('resultRulesSkipped', [
    String(report.skippedRules.length),
    report.skippedRules.join('; '),
  ])}`;
}

function scopeKey(scope: FillScope): ResultMessageKey {
  switch (scope) {
    case 'current-form':
      return 'resultScopeCurrentForm';
    case 'selected-input':
      return 'resultScopeSelectedInput';
    default:
      return 'resultScopeAllInputs';
  }
}

function capKey(reason: CapReason): ResultMessageKey {
  switch (reason) {
    case 'user-input':
      return 'resultCapUserInput';
    case 'time-budget':
      return 'resultCapTimeBudget';
    case 'values-unavailable':
      return 'resultCapValuesUnavailable';
    default:
      return 'resultCapPassCap';
  }
}

/**
 * What the badge shows (DD-006).
 *
 * The badge is the most contended surface — the active profile (UC-017) and the
 * domain-off indicator (UC-008) are persistent facts that will outrank a
 * transient count — so it carries the least that is still honest: the number,
 * and a marker when the fill did not settle.
 *
 * The marker exists because of DD-006's stated weakness: the tooltip is
 * hover-only, so a keyboard-only user never reads the sentence. If the badge
 * showed only a count, that user could not distinguish "6 filled" from "6
 * filled, and 2 of them may already be stale" — which is the reference's problem
 * of not knowing whether anything went wrong, reintroduced.
 */
export function badgeFor(counts: OutcomeCounts, capped: CapReason | undefined): {
  text: string;
  colour: string;
} {
  const text = counts.filled > 0 ? String(counts.filled) : '0';

  // The marker is for a capped fill and nothing else, which is what DD-006
  // decided. A failure already has its own colour and does not distort the
  // count — "27 filled" is true whether or not three others failed — whereas a
  // capped fill makes the count itself provisional, and that is the fact a
  // number cannot carry.
  //
  // The marker follows the cap and nothing else, so a fill that both failed and
  // capped still shows it — the two facts are independent, and dropping the
  // marker because something also failed would hide the more uncertain of them.
  const marked = capped === undefined ? text : `${text}!`;

  // Colour is the other way round: failure outranks capped, because a control
  // that could not be filled is a definite problem where a capped fill is an
  // uncertain one.
  if (counts.failed > 0) return { text: marked, colour: '#c0392b' };
  if (capped !== undefined) return { text: marked, colour: '#d68910' };
  return { text: marked, colour: counts.filled > 0 ? '#2f6fed' : '#8a8f98' };
}
