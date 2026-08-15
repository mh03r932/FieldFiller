import type {
  AgentSettings,
  CapReason,
  ControlKind,
  FieldDescriptor,
  FieldOutcome,
  FieldValue,
} from '../protocol';
import { collectCandidates } from './walk';
import { classifyStructural, matchesIgnorePattern, radioGroup, type StructuralContext } from './exclude';
import { describe } from './identify';
import { applyValue, verifyWrite } from './apply';
import { driveCombobox, stillAnswered } from './combobox';
import { realScheduler, waitForQuiescence, watchUserInput, type Scheduler } from './settle';

/**
 * The fixpoint loop — one frame's whole fill (DD-009, UC-034).
 *
 * A single-pass fill assumes the page is finished changing by the time it is
 * walked. Modern pages falsify that: choosing a country rewrites the state list,
 * ticking a box reveals three fields, picking a plan enables a seat count. So
 * this applies, watches what the page does in response, fills exactly what
 * changed, verifies every write survived, caps everything, and reports the caps.
 *
 * It lives here rather than in the entrypoint for the reason NFR-015 gives: the
 * entrypoint owns the messaging boundary, and everything below takes its DOM
 * root, its clock and its value source as parameters, so the DD-009 fixture
 * matrix can run under a test DOM instead of only in the end-to-end harness.
 *
 * The loop is affordable at all because of ND-1. Generation projects a persona
 * that exists before the page is touched, so a field described in pass 3
 * resolves to the same person as one described in pass 0. Under the reference's
 * order-dependent mirroring a "confirm email" filled in a later pass would
 * mirror whatever that pass happened to generate, and multi-pass filling would
 * have been incoherent by construction.
 */

/**
 * Where values come from. `undefined` means the source could not be reached —
 * the background was evicted mid-fill, or the extension is being updated
 * (UC-034 A12).
 */
export type ValueSource = (
  descriptors: readonly FieldDescriptor[],
) => Promise<readonly FieldValue[] | undefined>;

/**
 * Every bound in the loop, in one place, so none of them can be a number
 * somebody typed in the middle of a function.
 *
 * The figures come from the DD-009 fixture matrix
 * (`tests/fixtures/cascade.html`) rather than from round numbers — see each one.
 */
export type Bounds = {
  /**
   * Passes, including the first.
   *
   * Measured on 2026-08-15 by running the matrix with this lowered until it
   * broke: it *fills* in three passes — the chained cascade needs region →
   * district → ward — and *settles* in four, the fourth being the one that
   * establishes there is nothing left. At three it comes out filled but reports
   * itself capped, which is what the harness's settle row now catches.
   *
   * Eight is that doubled. Only a chain deeper than any in the matrix can need
   * more, and the cost of the headroom is bounded by `cascadeBudgetMs` rather
   * than by this number: a page that keeps producing work runs out of time long
   * before it runs out of passes.
   */
  readonly maxPasses: number;
  /**
   * How long without a mutation counts as the page having stopped.
   *
   * It has to outlast the gap between a cascade's first visible reaction and its
   * completion. The longest in the matrix is c3's 350 ms debounce, whose handler
   * clears the dependent list synchronously and repopulates it when the timer
   * fires — so the page's own first reaction restarts this timer and it only has
   * to outlast the remainder.
   */
  readonly quietMs: number;
  /**
   * The ceiling on one pass's wait. An animation, a carousel or a polling widget
   * can keep a page changing indefinitely, and none of them was caused by the
   * fill or can be told apart from a slow cascade (UC-034 A8).
   */
  readonly maxQuietWaitMs: number;
  /** NFR-034: the whole cascade, measured from the end of the first pass. */
  readonly cascadeBudgetMs: number;
  /**
   * How many times one control may be written during one fill.
   *
   * Without this, a single field whose handler clears it on every input — a real
   * validation bug, c7 in the matrix — drives every fill on that page to the
   * pass cap. The page would then report *itself* as capped and every other
   * field as possibly stale, because of one field. A per-control bound keeps the
   * failure where it belongs and lets the rest of the page settle honestly.
   *
   * Three: the write, a retry in case the first landed mid-cascade, and one more
   * before concluding that the page means it.
   */
  readonly writeAttempts: number;
  /**
   * How long one custom combobox may take before it is abandoned and the page
   * put back as it was found (FR-081, UC-034 A10).
   *
   * A combobox is not written, it is *driven*: opened, read, chosen from and
   * verified, with a wait for the page to render between each. That is orders of
   * magnitude more expensive than an assignment, and the cost is per control.
   */
  readonly comboboxControlMs: number;
  /**
   * How much of one pass may go on comboboxes in total.
   *
   * The measurement that opened step C found the *selector* costs 0.05 ms on a
   * 500-control page — but sixty comboboxes driven one after another is seconds,
   * and that is what would threaten NFR-001. Controls past the budget are
   * reported skipped, exactly as one that could not be driven is: the fill stays
   * inside its budget and says what it did not reach, rather than silently
   * becoming slow on the pages that use a design system.
   */
  readonly comboboxPassMs: number;
};

export const DEFAULT_BOUNDS: Bounds = {
  maxPasses: 8,
  quietMs: 400,
  maxQuietWaitMs: 1500,
  cascadeBudgetMs: 5000,
  writeAttempts: 3,
  comboboxControlMs: 250,
  comboboxPassMs: 2000,
};

export type FillLoopOptions = {
  readonly root: Document;
  readonly settings: AgentSettings;
  readonly requestValues: ValueSource;
  /**
   * Controls this extension has written, for as long as the page lives — so
   * "skip fields that already have content" does not treat our own earlier
   * values as the user's (BR-005-7). Identity only; no value is ever retained.
   */
  readonly writtenByUs: WeakSet<Element>;
  readonly bounds?: Bounds;
  readonly scheduler?: Scheduler;
};

export type FillLoopResult = {
  readonly outcomes: readonly FieldOutcome[];
  readonly passes: number;
  /** Absent when the frame settled of its own accord. */
  readonly capped?: CapReason;
  /** Controls the next pass would have worked on, when a bound stopped it. */
  readonly stale?: number;
};

/**
 * One control, for the life of one fill.
 *
 * `written` is the value *we* generated, never anything read from the page. It
 * is kept so the final sweep can ask whether that write survived, and it goes
 * with everything else when the report is sent (NFR-031, BR-034-11).
 */
type Tracked = {
  readonly ref: number;
  readonly token: string;
  readonly element: Element;
  kind: ControlKind;
  outcome: FieldOutcome | undefined;
  written: FieldValue | undefined;
  attempts: number;
};

export async function runFill(options: FillLoopOptions): Promise<FillLoopResult> {
  const { root, settings, requestValues, writtenByUs } = options;
  const bounds = options.bounds ?? DEFAULT_BOUNDS;
  const scheduler = options.scheduler ?? realScheduler;
  const { patterns, invalid } = compilePatterns(settings.ignorePatterns);

  if (invalid.length > 0) {
    // UC-005 A5: recorded once per fill, not once per field.
    console.warn(`[fieldfiller] ignoring ${invalid.length} invalid ignore pattern(s)`);
  }

  const structural: StructuralContext = {
    skipHidden: settings.skipHidden,
    skipPreFilled: settings.skipPreFilled,
    writtenByUs,
  };

  /**
   * Makes tokens unique across frames without any coordination between them,
   * which matters because the background seeds generation from the token: two
   * frames whose controls both started at `0` would draw the same value for
   * unrelated fields.
   */
  const salt = Math.random().toString(36).slice(2, 8);
  const tokens = new WeakMap<Element, Tracked>();
  const tracked: Tracked[] = [];
  const watch = watchUserInput(root);

  let capped: CapReason | undefined;
  let passes = 0;

  try {
    let cascadeStart: number | undefined;

    while (passes < bounds.maxPasses) {
      passes++;
      const pass = collect(true);

      if (pass.length === 0) break;

      const values = await requestValues(pass.map(descriptorFor));
      if (values === undefined) {
        // A12: every control in this pass is accounted for as failed, because a
        // control with no outcome vanishes from the count the user is shown
        // (BR-005-8) — the fill then looks smaller than it was rather than
        // failed. The commonest cause is the background being evicted mid-fill.
        for (const entry of pass) {
          entry.outcome = { ref: entry.ref, status: 'failed', cause: 'no values returned' };
        }
        capped = 'values-unavailable';
        break;
      }

      const wrote = await apply(pass, values);

      // The user outranks the fill, and their first real interaction ends the
      // cascade rather than merely narrowing it (BR-034-5).
      if (watch.interrupted()) {
        capped = 'user-input';
        break;
      }

      // Nothing was written, so nothing can have changed because of us.
      // Whatever is left is either something we are not allowed to fill or
      // something the page will not accept, and neither improves with a wait.
      if (wrote === 0) break;

      if (passes >= bounds.maxPasses) {
        capped = 'pass-cap';
        break;
      }

      // NFR-034 measures the cascade from the end of the first pass. That pass
      // is what the user perceives as the form filling and is bounded by
      // NFR-001 instead; folding the two together would make the responsiveness
      // budget depend on how argumentative the page is.
      cascadeStart ??= scheduler.now();
      if (scheduler.now() - cascadeStart >= bounds.cascadeBudgetMs) {
        capped = 'time-budget';
        break;
      }

      await waitForQuiescence(
        root,
        { quietMs: bounds.quietMs, maxMs: bounds.maxQuietWaitMs },
        scheduler,
      );

      if (watch.interrupted()) {
        capped = 'user-input';
        break;
      }
    }

    // UC-034 step 8, and the half of FR-076 that needs the loop: did the write
    // *survive*. Only a demotion is possible — a control whose value did not
    // last stops being filled, but one we never filled is not promoted because
    // the page happens to have put something there itself.
    for (const entry of tracked) {
      if (entry.outcome?.status !== 'filled' || entry.written === undefined) continue;

      const verified =
        entry.written.as === 'pick'
          ? stillAnswered(entry.element)
          : verifyWrite(entry.element, entry.written);

      if (!verified.landed) {
        entry.outcome = { ref: entry.ref, status: 'failed', cause: verified.reason };
      }
    }

    return {
      outcomes: report(),
      passes,
      // Recorded without deciding anything, which is why `collect` is asked not
      // to write outcomes here: this is a count of the work a further pass would
      // have found, not a further pass.
      ...(capped === undefined ? {} : { capped, stale: collect(false).length }),
    };
  } finally {
    // NFR-035. The agent is on every page the user visits (DD-001), so anything
    // left listening is paid for on all of them rather than on the filled one.
    watch.release();
  }

  function trackedFor(element: Element, kind: ControlKind): Tracked {
    const existing = tokens.get(element);
    if (existing !== undefined) {
      // The same element seen again in a later pass, which is the whole point of
      // the token: a position is not an identity, and a control revealed by an
      // earlier answer shifts the position of every control after it.
      existing.kind = kind;
      return existing;
    }

    const ref = tracked.length;
    const entry: Tracked = {
      ref,
      token: `${salt}-${ref}`,
      element,
      kind,
      outcome: undefined,
      written: undefined,
      attempts: 0,
    };
    tokens.set(element, entry);
    tracked.push(entry);
    return entry;
  }

  /**
   * One token per actual radio group, derived from its first member so that it
   * is stable across passes — the group's answer is seeded from it, and a token
   * that changed between passes would give the group a different answer every
   * time the page made us write it again.
   *
   * Resolved here because this is the only side that can: `radioGroup` scopes by
   * the owning form, so two forms using the same `name` get two tokens
   * (BR-005-3).
   */
  function groupTokenFor(entry: Tracked): string | undefined {
    if (entry.kind !== 'radio' || !(entry.element instanceof HTMLInputElement)) return undefined;
    const first = radioGroup(entry.element)[0] ?? entry.element;
    return `g${trackedFor(first, 'radio').token}`;
  }

  /**
   * Rebuilt every pass rather than cached. A select whose options were rewritten
   * is the case this whole decision exists for, and a cached descriptor would
   * hand the generator the list the page has already thrown away — choosing,
   * once again, from a list that no longer exists (UC-034 A1).
   */
  function descriptorFor(entry: Tracked): FieldDescriptor {
    return describe(entry.element, entry.ref, entry.kind, {
      group: groupTokenFor(entry),
      token: entry.token,
    });
  }

  /**
   * What the next pass should work on.
   *
   * The rule is one line: **every currently fillable control except one that is
   * still holding a value we wrote.** Everything BR-034-7 enumerates falls out
   * of it — a control that did not exist, one whose options have been rewritten,
   * one excluded for a reason that no longer applies, one whose value did not
   * survive — without the loop having to detect each shape separately, and
   * without keeping any snapshot of the page between passes.
   *
   * That last part is deliberate. Remembering a control's previous option list
   * so as to compare against it would mean holding page-originated data across
   * passes; asking `verifyWrite` whether our chosen option is still the selected
   * one answers the same question from the page's present state and retains
   * nothing (BR-034-11).
   *
   * `record` is false only where the answer is being counted rather than acted
   * on, so that measuring the work left over cannot itself re-decide anything.
   */
  function collect(record: boolean): Tracked[] {
    const fillable: Tracked[] = [];

    for (const element of collectCandidates(root)) {
      const classification = classifyStructural(element, structural);
      const entry = trackedFor(element, classification.fillable ? classification.kind : 'text');

      // Still holding what we wrote: left alone, and it keeps the outcome it
      // already earned. Reporting it as `pre-filled` would be a lie about why it
      // was left alone, and one the badge would then repeat (BR-034-7).
      if (entry.outcome?.status === 'filled' && entry.written !== undefined) {
        const holding =
          entry.written.as === 'pick'
            ? stillAnswered(element)
            : verifyWrite(element, entry.written);
        if (holding.landed) continue;
      }

      // FR-079. Ahead of classification, so a control the user is typing into is
      // never even described, let alone written.
      if (watch.touched.has(element)) {
        if (record) entry.outcome = { ref: entry.ref, status: 'skipped', reason: 'user-touched' };
        continue;
      }

      // Its own cap has fired; the outcome it earned on its last attempt stands.
      // Left out so that one control the page will not let us fill cannot keep
      // the whole frame looping on its behalf.
      if (entry.attempts >= bounds.writeAttempts) continue;

      if (!classification.fillable) {
        // Re-decided every pass, never carried forward: the reason a control was
        // excluded in pass 1 is a statement about pass 1 (UC-034 A2).
        if (record) {
          entry.outcome = { ref: entry.ref, status: 'skipped', reason: classification.reason };
        }
        continue;
      }

      if (patterns.length > 0) {
        const sources = Object.values(descriptorFor(entry).sources);
        if (matchesIgnorePattern(sources, patterns)) {
          if (record) {
            entry.outcome = { ref: entry.ref, status: 'skipped', reason: 'ignored-pattern' };
          }
          continue;
        }
      }

      fillable.push(entry);
    }

    return fillable;
  }

  /**
   * Drives one custom combobox, and turns the result into an outcome (FR-081).
   *
   * The two ways of not succeeding are kept apart, because they mean different
   * things to whoever reads the report: a control the ladder could not operate
   * is a gap in what this extension supports, and one that never got a turn is a
   * page too big for the budget. Both are skips, and neither is a failure —
   * nothing was written, and the page was put back as it was found (UC-034 A10).
   */
  async function drive(
    entry: Tracked,
    at: number,
    provenance: string,
    budgetLeft: number,
  ): Promise<FieldOutcome> {
    if (budgetLeft <= 0) {
      return { ref: entry.ref, status: 'skipped', reason: 'combobox-not-driveable' };
    }

    const result = await driveCombobox(entry.element, {
      at,
      scheduler,
      budgetMs: Math.min(budgetLeft, bounds.comboboxControlMs),
    });

    if (!result.driven) {
      return { ref: entry.ref, status: 'skipped', reason: 'combobox-not-driveable' };
    }

    writtenByUs.add(entry.element);
    return { ref: entry.ref, status: 'filled', provenance: `${provenance} (${result.rung})` };
  }

  /** Writes one pass's values, and returns how many controls were acted on. */
  async function apply(entries: readonly Tracked[], values: readonly FieldValue[]): Promise<number> {
    const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
    // Spent across the whole pass, not per control: sixty comboboxes at a
    // quarter-second each is fifteen seconds, and no single one of them is at
    // fault for that.
    let comboboxLeft = bounds.comboboxPassMs;
    let wrote = 0;

    for (const value of values) {
      const entry = byRef.get(value.ref);
      if (entry === undefined) continue;

      if (value.as === 'skip') {
        entry.outcome = { ref: value.ref, status: 'skipped', reason: value.reason };
        continue;
      }

      // The user may have started typing between this pass being described and
      // its values arriving — a real window, because that is a round trip.
      if (watch.touched.has(entry.element)) {
        entry.outcome = { ref: value.ref, status: 'skipped', reason: 'user-touched' };
        continue;
      }

      entry.attempts++;
      wrote++;

      // Per element, so one hostile control cannot end the run (BR-004-11,
      // FR-010). The reference lets a single throw abandon the rest of the page.
      try {
        if (value.as === 'pick') {
          entry.written = value;
          entry.outcome = await drive(entry, value.at, value.provenance, comboboxLeft);
          comboboxLeft -= Math.min(comboboxLeft, bounds.comboboxControlMs);
          continue;
        }

        // Wrapped, because a checkbox or radio written with `click()` makes the
        // *browser* fire `input` and `change` — trusted events with no user
        // behind them (FR-079). See `ignoreWhile`.
        watch.ignoreWhile(() =>
          applyValue(entry.element, value, { dispatchEvents: settings.dispatchEvents }),
        );

        // FR-076, the first of the two checks: did the write take. `applyValue`
        // dispatches its events synchronously, so a page that reverts us from a
        // handler has already done so. The sweep after the loop is the other
        // check, and the only one that can see a page reverting on a timer.
        const verified = verifyWrite(entry.element, value);
        entry.written = value;

        if (!verified.landed) {
          entry.outcome = { ref: value.ref, status: 'failed', cause: verified.reason };
          continue;
        }

        // Only once the write is known to have survived. Recording a control we
        // did not actually fill would make the *page's* content look like ours
        // on the next fill (BR-005-7).
        writtenByUs.add(entry.element);
        entry.outcome = { ref: value.ref, status: 'filled', provenance: value.provenance };
      } catch (error) {
        entry.outcome = { ref: value.ref, status: 'failed', cause: String(error) };
      }
    }

    return wrote;
  }

  /**
   * One outcome per control, taken from the state the control was actually in
   * when the fill ended (BR-034-2).
   *
   * A control the page removed is left out rather than reported. Its fate is not
   * unknown — it is not on the settled page, and this is an account of the page
   * as it settled. Keeping it would mean claiming a field the user cannot see,
   * which is the same dishonesty in the count that write verification exists to
   * remove; the control that replaced it is reported in its own right, filled
   * with the same value it was given before (UC-034 A7, BR-034-3).
   */
  function report(): FieldOutcome[] {
    const outcomes: FieldOutcome[] = [];
    for (const entry of tracked) {
      if (entry.outcome === undefined || !entry.element.isConnected) continue;
      outcomes.push(entry.outcome);
    }
    return outcomes;
  }
}

/**
 * Compiles the ignore patterns once per fill (ND-15, NFR-025).
 *
 * The reference constructs a `RegExp` per element per rule, per fill — 500
 * controls × 100 rules is 50,000 constructions in one run, and the loop would
 * now multiply that by the pass count. An invalid pattern is skipped rather than
 * fatal (UC-005 A5): one bad pattern must not stop the other exclusions from
 * being applied.
 */
function compilePatterns(sources: readonly string[]): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      invalid.push(source);
    }
  }
  return { patterns, invalid };
}
