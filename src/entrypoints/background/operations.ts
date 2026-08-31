import {
  generateBatch,
  tokenRandom,
} from '@/lib/generators/batch';
import type { BehaviourDefaults } from '@/lib/generators/default-generator';
import { slowRules, type CompiledRule } from '@/lib/rules/match';
import {
  badgeFor,
  fieldsFromReport,
  noteDescriptors,
  type FieldNotes,
} from '@/lib/report/surface';
import type {
  CapReason,
  FieldReportEntry,
  FillReport,
  FillScope,
  FrameReport,
  FromAgentMessage,
  OperationId,
  OutcomeCounts,
  ScopeRefusal,
  ScopeRule,
  ValuesResponse,
} from '@/lib/protocol';
import type { Persona, Random } from '@/lib/persona/persona';
import { trace } from './trace';

/**
 * The operation registry: live fills, by operation id (UC-001, DD-009).
 *
 * Extracted from the background entrypoint when it was split, and given the
 * one injection the split existed to make possible: the clock and the timer
 * go through `deps.clock`, the same seam `lib/page/settle.ts` proves, so the
 * join window, the settle scheduling and the sliding timeout — real timing
 * decisions, previously testable only end-to-end — can be exercised with a
 * fake clock (NFR-015).
 *
 * The persona is created when the fill begins and held only for the fill's
 * lifetime (BR-004-1a). NFR-031 requires generated data to be discarded when
 * the fill completes, so the registry is cleared as the report lands — it is
 * a working set, never a cache, and nothing here is ever written to storage.
 */

/**
 * How long an operation may stay open with nothing happening before it is
 * abandoned — a sliding deadline, restarted by every sign of progress.
 *
 * A fill ends when its report arrives — but a report is not guaranteed to. If
 * the frame navigates between sending its descriptors and sending its report,
 * nothing ever comes back, and without this the tab stays claimed forever:
 * every later fill on that tab is ignored as "already running", and the only
 * cure is the service worker being evicted. An extension that silently stops
 * working until the browser restarts it is worse than one that fails loudly.
 *
 * Sliding rather than a larger fixed figure (DD-009). A cascading page now takes
 * seconds and several round trips, and a fixed timeout long enough for the worst
 * of those would keep the tab locked for just as long after a frame *navigated*
 * mid-fill — making the common failure worse to fix the rare one. Restarting it
 * on each descriptor batch frees a dead agent as quickly as before and never
 * abandons a working one.
 */
const OPERATION_TIMEOUT_MS = 15_000;

/**
 * How long a frame has to say it is participating.
 *
 * A page and its frames are one fill (BR-001-1). `tabs.sendMessage` broadcasts
 * but returns a single reply, frames cannot see each other, and asking the
 * browser which frames exist needs a permission NFR-008 forbids — so each frame
 * says so itself, the moment it takes the instruction up. Every frame that is
 * going to join does so in the same turn as the broadcast; this is generous
 * against a frame still parsing when the instruction arrived.
 */
const JOIN_WINDOW_MS = 300;

/**
 * The backstop for a frame that joined and then stopped existing.
 *
 * A fill now ends when every frame that joined has reported, which is a fact
 * rather than an inference. This covers the one case that leaves: a frame that
 * announced itself and then navigated, so its report is never coming. Longer
 * than the agent's own longest silence mid-fill — one pass's maximum wait for
 * the page to go quiet — so a slow frame is never mistaken for a dead one.
 */
const ABANDON_AFTER_MS = 2500;

/**
 * The clock and the timer, injected — the same shape `lib/page/settle.ts`
 * names `Scheduler`, restated here rather than imported so the background does
 * not reach into the page's modules for a type. The handle is cast the way
 * `settle.ts` casts it: DOM and Node disagree on what `setTimeout` returns,
 * and the registry only ever passes the handle back to `clearTimeout`.
 */
export type Clock = {
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
  readonly now: () => number;
};

export const realClock: Clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

type Operation = {
  readonly persona: Persona;
  readonly random: Random;
  /**
   * The operation's seed, kept so that generation can be re-derived per control
   * rather than drawn from a stream (FR-080). New for every fill, which is what
   * keeps values fresh across fills while stable within one (FR-075).
   */
  readonly seed: number;
  readonly tabId: number;
  readonly outcomes: OutcomeCounts;
  /** Frames that said they were participating, and are owed a report. */
  readonly joined: Set<string>;
  /** Frames that have reported, so a duplicate cannot be counted twice. */
  readonly frames: Set<string>;
  /** When the fill began, so the window for frames to join can be closed. */
  readonly started: number;
  /** The last sign of life from any frame, for telling a slow one from a dead one. */
  lastProgress: number;
  /** Abandons the operation if no report ever arrives. */
  timeout: number;
  /** Fires once the reports have stopped arriving. */
  settle: number | undefined;
  /** Set by the first frame that stops at a bound rather than settling. */
  capped: CapReason | undefined;
  /** How many controls those frames say may be stale (FR-078). */
  stale: number;
  /** Which scope was asked for, so the result can say which one ran (DD-006, DD-008). */
  readonly scope: FillScope;
  /**
   * What each frame said its controls were, keyed by frame and ref.
   *
   * Page-derived, and held only for this operation and the one report it
   * produces — `lib/report/surface.ts` states the bound in full.
   */
  readonly notes: FieldNotes;
  /** The per-control rows, accumulated as frames report (FR-009, FR-069). */
  fields: FieldReportEntry[];
  /**
   * The user's rules, compiled once when the fill begins (NFR-025, ND-15).
   *
   * Per operation rather than per batch, because a page with frames sends one
   * batch per frame per pass — compiling per batch would rebuild every pattern
   * on every pass of every frame, which is the cost ND-15 names.
   */
  readonly rules: readonly CompiledRule[];
  /**
   * The behaviour defaults this fill runs with (UC-022).
   *
   * Captured when the fill begins, for the same reason the persona and the
   * compiled rules are: settings are read once per operation, so every batch of
   * every frame is generated against one configuration. Reading them per batch
   * would let a fill that spans a settings change tick a consent box in one
   * frame and not in the next, which is the incoherence ND-1 exists to prevent
   * wearing a different hat.
   */
  readonly defaults: BehaviourDefaults;
  /**
   * The label of the profile governing this fill, if any (UC-017, FR-047).
   *
   * Resolved once when the fill begins, from the address read at that moment.
   * It cannot be resolved later — the tab may have navigated, and we would have
   * no right to read the new address anyway.
   */
  readonly profile: string | undefined;
  /** Rules that could not run, by label, so the user is told (DD-005). */
  readonly skippedRules: Set<string>;
  /**
   * What matching has cost this fill, rule by rule (NFR-032).
   *
   * Summed across every frame and every pass, because that is the scale the
   * bound is stated at: one batch of a 500-control page is one frame's share of
   * one pass, and a rule that is slow is slow in all of them.
   */
  readonly matchCostMs: Map<string, number>;
  /** The same, for field-exclusion patterns, which are measured in the agent (NFR-032). */
  readonly excludeCostMs: Map<string, number>;
  /**
   * Exclusions this fill did not send to the page, by pattern (NFR-009).
   *
   * A list rather than a set, and fixed at the start rather than accumulated:
   * every frame in the operation was sent the same settings, so this is a fact
   * about the fill and not something the frames report back.
   */
  readonly skippedExclusions: readonly string[];
  /** Set when the frame refused to resolve a scope (UC-002 A3, UC-003 A2). */
  refused: ScopeRefusal | undefined;
  /**
   * Which rung of DD-008's ladder resolved the scope (BR-002-4).
   *
   * First frame to report one wins, on the same terms as `refused` below it: a
   * narrowed scope is resolved in one frame — the one the user pointed at — and
   * the others are walking the page scope, which has no rung to name.
   */
  scopeRule: ScopeRule | undefined;
};

/**
 * What `complete` owes the outside world when an operation's report is ready:
 * the report itself, and the badge that reports it. The registry decides both;
 * the caller decides what holding a report and drawing a badge mean — including
 * the badge's tooltip sentence, so this module stays catalog-free.
 */
export type Completion = {
  readonly report: FillReport;
  readonly tabId: number;
  readonly badge: { readonly text: string; readonly colour: string };
};

export function createOperations(deps: {
  readonly clock: Clock;
  /** Called once per operation, with the finished report. */
  readonly onCompleted: (completion: Completion) => void;
}) {
  const operations = new Map<OperationId, Operation>();
  /** Tabs with a fill in progress, so a second invocation is ignored (UC-001 A7). */
  const filling = new Set<number>();

  /**
   * Claims a tab for a fill. False means one is already running, and the caller
   * ignores the new trigger rather than queueing it: two overlapping fills would
   * write two personas into one form.
   */
  function claimTab(tabId: number): boolean {
    if (filling.has(tabId)) {
      trace(`fill already running in tab ${tabId}; ignoring`);
      return false;
    }
    // Claimed before the first `await` in `startFill`, so a second trigger
    // arriving during the setup is ignored rather than starting a second
    // persona. Every path out releases it — which is why the setup is inside
    // the `try` and not above it. Until `operations` holds the operation there
    // is no timeout to rescue the tab, so a throw between these two points
    // would leave the tab unfillable for as long as the worker lives.
    filling.add(tabId);
    return true;
  }

/** Everything an operation is given at birth; the registry fills in the rest. */
type OperationBase = Omit<
  Operation,
  'lastProgress' | 'timeout' | 'settle' | 'capped' | 'stale' | 'refused' | 'scopeRule'
>;

  /** Registers an operation the caller has assembled, arming its timeout. */
  function register(operationId: OperationId, base: OperationBase): void {
    const operation: Operation = {
      ...base,
      lastProgress: base.started,
      settle: undefined,
      capped: undefined,
      stale: 0,
      refused: undefined,
      scopeRule: undefined,
      timeout: deps.clock.setTimeout(() => {
        trace(`fill ${operationId} timed out with no report; abandoning`);
        finish(operationId, base.tabId);
      }, OPERATION_TIMEOUT_MS),
    };
    operations.set(operationId, operation);
  }

  /** Ends an operation, discarding the persona and every generated value (NFR-031). */
  function finish(operationId: OperationId, tabId: number): void {
    const operation = operations.get(operationId);
    if (operation !== undefined) {
      deps.clock.clearTimeout(operation.timeout);
      if (operation.settle !== undefined) deps.clock.clearTimeout(operation.settle);
    }
    operations.delete(operationId);
    filling.delete(tabId);
  }

  /**
   * Closes an operation once every frame that joined has reported.
   *
   * The old rule was "close when reports stop arriving for a while", which was
   * sound while a fill was one walk: every frame reported within milliseconds of
   * the others, so silence really did mean completion. DD-009 broke that — a
   * frame's duration now depends on how much its own page cascades, so two frames
   * in one tab can finish seconds apart. The window that made the badge feel
   * prompt was then also the window that dropped the slower frame's outcomes, and
   * a fill of 33 fields reported 27 with nothing to indicate that anything was
   * missing. Silence and slowness are not distinguishable by waiting longer; they
   * are distinguishable by the frames saying which of the two they are.
   */
  function complete(operationId: OperationId): void {
    const operation = operations.get(operationId);
    if (operation === undefined) return;

    const outstanding = [...operation.joined].filter((frame) => !operation.frames.has(frame)).length;
    if (outstanding > 0) {
      const idle = deps.clock.now() - operation.lastProgress;
      if (idle < ABANDON_AFTER_MS) {
        // Measured from the last sign of life, never from the start: a frame in a
        // long cascade is making progress the whole time, and a deadline counted
        // from the trigger would abandon exactly the frames this exists to wait
        // for.
        operation.settle = deps.clock.setTimeout(() => complete(operationId), ABANDON_AFTER_MS - idle);
        return;
      }
      trace(`fill ${operationId}: ${outstanding} frame(s) never reported; closing without them`);
    }

    const { filled, skipped, failed } = operation.outcomes;
    trace(
      `fill ${operationId}: ${filled} filled, ${skipped} skipped, ` +
        `${failed} failed across ${operation.frames.size} frame(s)` +
        (operation.capped === undefined
          ? ''
          : `, capped (${operation.capped}) with ${operation.stale} possibly stale`),
    );

    const report: FillReport = {
      scope: operation.scope,
      finishedAt: deps.clock.now(),
      counts: { ...operation.outcomes },
      capped: operation.capped,
      stale: operation.stale,
      skippedRules: [...operation.skippedRules],
      slowRules: slowRules(operation.matchCostMs),
      slowExclusions: slowRules(operation.excludeCostMs),
      skippedExclusions: operation.skippedExclusions,
      refused: operation.refused,
      scopeRule: operation.scopeRule,
      profile: operation.profile,
      fields: operation.fields,
    };

    // BR-001-4: nothing to fill is a success, not a failure, and must be
    // distinguishable from one.
    const badge = badgeFor(operation.outcomes, operation.capped);
    // Held before the badge is drawn, so the report exists the moment the user
    // could act on seeing it. One fill's worth, in memory, replacing whatever the
    // previous fill left — see `lib/report/surface.ts` on what that permits.
    deps.onCompleted({ report, tabId: operation.tabId, badge });
    finish(operationId, operation.tabId);
  }

  function summarise(report: FrameReport, counts: OutcomeCounts): void {
    for (const outcome of report.outcomes) {
      // An explicit switch rather than `counts[outcome.status]++`. The status
      // arrives from a page agent that may be a previous version of this
      // extension, so it is a claim rather than a guarantee — and indexing a plain
      // object with an unvalidated string is how `__proto__` and `constructor`
      // find their way into a counter. An unrecognised status is ignored, which is
      // also what makes adding a status a visible change here rather than a
      // silently miscounted one.
      switch (outcome.status) {
        case 'filled':
          counts.filled++;
          break;
        case 'skipped':
          counts.skipped++;
          break;
        case 'failed':
          counts.failed++;
          break;
      }
    }
  }

  return {
    claimTab,
    register,
    finish,

    /** A frame announced itself as participating. */
    joined(raw: Extract<FromAgentMessage, { kind: 'joined' }>): void {
      const operation = operations.get(raw.operationId);
      if (operation === undefined) return;
      operation.lastProgress = deps.clock.now();
      operation.joined.add(raw.frame);
    },

    /**
     * The descriptors half of the round trip: values out. Slides the timeout —
     * a frame working through a cascade sends one of these per pass, which is
     * what keeps a long fill alive without giving a dead one the same grace.
     *
     * Returns whether an answer was sent. An unknown operation id is not an
     * error — the background may have been evicted and restarted since the
     * fill began, taking the persona with it — but there is nothing to answer
     * with, so the caller must let the channel *close* rather than hold it:
     * the page agent awaits this reply with no timeout of its own, and an open
     * channel on an unanswered request is a fill loop stalled until the worker
     * is evicted. A closed channel resolves its `await` with `undefined`,
     * which is exactly the "no answer" reading the agent has a capped outcome
     * for. That difference — respond-and-hold versus close — is why this
     * returns a boolean, in `answerReportRequest`'s shape.
     */
    descriptors(
      raw: Extract<FromAgentMessage, { kind: 'descriptors' }>,
      sendResponse: (value: ValuesResponse) => void,
    ): boolean {
      const operation = operations.get(raw.operationId);
      if (operation === undefined) {
        trace(`fill ${raw.operationId}: values requested for an operation this build no longer holds`);
        return false;
      }
      operation.lastProgress = deps.clock.now();

      deps.clock.clearTimeout(operation.timeout);
      operation.timeout = deps.clock.setTimeout(() => {
        trace(`fill ${raw.operationId} went quiet before reporting; abandoning`);
        finish(raw.operationId, operation.tabId);
      }, OPERATION_TIMEOUT_MS);

      // Recorded before generation, so a control that fails to receive a value
      // still has a name in the report. An agent that predates DD-006 sends no
      // frame token; its rows then join to nothing and say "unknown field",
      // which is the honest outcome rather than attributing them to a frame.
      if (raw.frame !== undefined) {
        noteDescriptors(operation.notes, raw.frame, raw.descriptors);
      }

      const batch = generateBatch(raw.descriptors, {
        persona: operation.persona,
        rules: operation.rules,
        defaults: operation.defaults,
        // Per control, derived from the operation's seed and the control's
        // token, so a control the page makes us write twice gets the same value
        // both times (FR-080). An agent from a build before DD-009 sends no
        // token and falls back to the shared stream, which is exactly what it
        // used to get.
        randomFor: (token) =>
          token === undefined ? operation.random : tokenRandom(operation.seed, token),
        // NFR-032's measurement. `Date.now()` rather than `performance.now()`
        // because this is elapsed time and nothing else — the same clock the
        // operation timeout and the badge already use, and the numbers it
        // produces are compared against a 100 ms bound where a millisecond of
        // resolution is noise.
        now: Date.now,
      });
      for (const note of batch.skippedRules) operation.skippedRules.add(note);
      for (const [label, spent] of batch.matchCostMs) {
        operation.matchCostMs.set(label, (operation.matchCostMs.get(label) ?? 0) + spent);
      }
      sendResponse({
        kind: 'values',
        operationId: raw.operationId,
        values: batch.values,
      });
      return true;
    },

    /** One frame's report, and the check that may close the operation. */
    report(raw: Extract<FromAgentMessage, { kind: 'report' }>): void {
      const operation = operations.get(raw.operationId);
      if (operation === undefined) return;
      operation.lastProgress = deps.clock.now();

      // A duplicate — a frame that somehow reports twice — must not double the
      // count the user is shown. Keyed on the frame's own token, never its URL:
      // two iframes with the same `src` are ordinary and every srcdoc frame
      // calls itself `about:srcdoc`, so a URL key discards the second frame's
      // report — and its outcomes go uncounted while the frame it was confused
      // with closes the operation.
      if (operation.frames.has(raw.report.frame)) return;
      operation.frames.add(raw.report.frame);
      summarise(raw.report, operation.outcomes);
      // The counts above and the rows here come from the same outcomes, so the
      // report cannot disagree with the badge about how many fields were filled.
      operation.fields.push(...fieldsFromReport(operation.notes, raw.report));
      // First refusal wins, as the first cap does: a page-scope fill broadcasts to
      // every frame and only the narrow scopes can refuse, so at most one frame
      // ever sets this.
      for (const [pattern, spent] of Object.entries(raw.report.excludeCostMs ?? {})) {
        operation.excludeCostMs.set(pattern, (operation.excludeCostMs.get(pattern) ?? 0) + spent);
      }
      operation.refused ??= raw.report.refused;
      operation.scopeRule ??= raw.report.scopeRule;

      // One frame stopping at a bound caps the whole fill: the user is being told
      // whether this page was settled, and "settled except for that iframe" is not
      // settled (BR-034-6). The first reason wins rather than the last, because a
      // later frame's clean finish must not erase an earlier frame's cap.
      if (raw.report.capped !== undefined) {
        operation.capped ??= raw.report.capped;
        operation.stale += raw.report.stale ?? 0;
      }

      // Each frame reports independently and none waits for another (BR-001-5),
      // so the operation closes when every frame that joined has had its say.
      //
      // Rescheduled rather than fired directly, because a frame can report before
      // a slower sibling has even joined. Nothing is decided until the join window
      // has passed; after that, the check runs the moment a report arrives.
      if (operation.settle !== undefined) deps.clock.clearTimeout(operation.settle);
      operation.settle = deps.clock.setTimeout(
        () => complete(raw.operationId),
        Math.max(0, operation.started + JOIN_WINDOW_MS - deps.clock.now()),
      );
    },
  };
}

export type Operations = ReturnType<typeof createOperations>;
