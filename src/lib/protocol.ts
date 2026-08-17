/**
 * The background ↔ page-agent message protocol.
 *
 * Platform-free by construction: no `chrome.*`, no `browser.*`, no DOM. Both
 * sides of the boundary import it (NFR-015).
 *
 * The shape follows DD-003. The agent walks and applies but carries no corpus,
 * so one fill costs one round trip *per pass*: descriptors out, values back
 * (NFR-029). The background sends the initial instruction, which is what lets
 * the persona exist before any frame is asked for anything (BR-004-1a).
 *
 * DD-009 amended that from "one round trip" to "one per pass", and the protocol
 * grows **compatibly** to carry it: `token` on a descriptor, `passes` and
 * `capped` on a frame report, all optional. After an update, tabs opened
 * beforehand keep running the previous build until they reload, so a report in
 * the old shape must keep validating — absent `passes` means the agent made one
 * pass, which is exactly what an agent that predates the loop did.
 */

/** The three fill scopes, all built: UC-001, and UC-002 and UC-003 since 2026-08-15. */
export type FillScope = 'all-inputs' | 'current-form' | 'selected-input';

/**
 * How the fill was invoked, which decides where the anchor comes from
 * (UC-002 A1, UC-003 A2).
 *
 * The scope alone cannot answer that. "Fill this form" from the context menu
 * means the form around the element under the pointer; the same scope from a
 * keyboard shortcut means the form around whatever is focused, and there is no
 * pointer involved at all. Sending only the scope left the agent guessing, and
 * it guessed by preferring the last right-clicked element whenever one still
 * existed — so a single right-click anywhere on a page redirected every later
 * shortcut on that page for as long as it stayed open.
 *
 * `toolbar` shares `shortcut`'s answer rather than having one of its own: a
 * click on our own toolbar button is not aimed at anything in the page either.
 * The two are kept apart in the type because they are different channels and
 * FR-005 and FR-050 are different requirements.
 */
export type FillTrigger = 'menu' | 'shortcut' | 'toolbar';

const FILL_TRIGGERS: readonly FillTrigger[] = ['menu', 'shortcut', 'toolbar'];

/**
 * Identifies one fill operation across every message and every frame it touches.
 *
 * A page and its frames are one fill sharing one persona (BR-001-1). Frames
 * cannot talk to each other, so the operation id is what ties their independent
 * exchanges to the same person.
 */
export type OperationId = string;

/**
 * Every control the engine can fill.
 *
 * Kept as a closed union rather than a string so that adding a control type is a
 * compile error everywhere it must be handled — the generator, the applier and
 * the sizing defaults — instead of a silent fallthrough to lorem ipsum.
 */
export type ControlKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'search'
  | 'password'
  | 'textarea'
  | 'number'
  | 'range'
  | 'date'
  | 'datetime-local'
  | 'month'
  | 'week'
  | 'time'
  | 'color'
  | 'checkbox'
  | 'radio'
  | 'select-one'
  | 'select-multiple'
  | 'contenteditable'
  /**
   * A control that behaves as a select without being one — the ARIA combobox
   * and listbox patterns every design system reimplements (FR-081, UC-034 A9).
   *
   * Never a native control wearing the role: an `<input role="combobox">` is a
   * text input with autocomplete attached, and filling it as text is right.
   * Only a non-native element gets this kind.
   */
  | 'combobox';

/** One choice offered by a select or a radio group. */
export type ControlOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
};

/**
 * What a control *is* — never what it currently holds (BR-004-10, NFR-030).
 *
 * Nothing needs a field's existing value to choose a generator, and not
 * collecting it is what makes the privacy claim structural rather than promised.
 * Identity is kept per source rather than concatenated, so a pattern can be
 * anchored and the matched source can be reported (ND-2, BR-004-5) — Phase 2
 * uses that; Phase 1 only has to avoid designing it away.
 */
export type FieldDescriptor = {
  /**
   * Handle for pairing values back up, unique within the frame.
   *
   * Assigned in the order controls are first sighted and kept for the rest of
   * the operation, so the same control carries the same `ref` in every pass and
   * the frame's report can hold one outcome per control (BR-034-2).
   */
  readonly ref: number;
  /**
   * Identifies one control across the passes of one fill, and across frames.
   *
   * `ref` is unique within a frame; this is unique within the operation, which
   * is what the background needs to seed generation per control (FR-080).
   * Without it a control re-described in a later pass would draw the next value
   * from the operation's stream instead of the same one again — so an email
   * refilled in pass 2 would stop matching the "confirm email" filled in pass 1,
   * and FR-024 would be broken by the loop itself, invisibly.
   *
   * Optional because an agent from a build before DD-009 does not send it. The
   * background falls back to the operation's shared stream, which is exactly
   * what that agent used to get.
   */
  readonly token?: string;
  readonly kind: ControlKind;
  readonly sources: {
    readonly name?: string;
    readonly id?: string;
    /**
     * The `class` attribute, verbatim (FR-027).
     *
     * The noisiest source by a distance — a utility-first stylesheet puts twenty
     * meaningless tokens here, and a component library puts its own vocabulary.
     * It is carried anyway because the other half of real markup names its
     * fields in exactly this attribute and nowhere else, and because FR-028's
     * per-source toggles are how a user turns off a source that is noise on
     * *their* pages. The alternative — deciding for everyone that class is
     * untrustworthy — is the flattening ND-2 exists to prevent, made worse by
     * being invisible.
     */
    readonly className?: string;
    readonly label?: string;
    readonly placeholder?: string;
    readonly ariaLabel?: string;
  };
  /** The `autocomplete` token, a better identity signal than a regex on `id`. */
  readonly autocomplete?: string;
  /**
   * What the page's own validation will accept (D9, BR-004-7).
   *
   * The reference honours none of `step`, `minlength` or `pattern`, so it
   * generates values the page then rejects — which defeats the entire purpose of
   * filling the form.
   */
  readonly constraints: {
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly min?: string;
    readonly max?: string;
    readonly step?: string;
    readonly pattern?: string;
    readonly required?: boolean;
  };
  /** For selects and radio groups. Absent for every other kind. */
  readonly options?: readonly ControlOption[];
  /**
   * Identifies the radio group this control belongs to. Present only on radios.
   *
   * A token assigned by the agent, not the group's `name`. Two forms on one page
   * may legitimately use the same name for unrelated groups (BR-005-3), so
   * keying on the name would merge them and let one group's choice decide the
   * other's. The agent resolves real membership through `element.form` and
   * hands out one token per actual group.
   *
   * The background generates one choice per token and gives every member the
   * same answer. Without that, each radio picks independently: they disagree,
   * and for a two-option group the members choose *each other* about a quarter
   * of the time, leaving nothing selected at all.
   *
   * Derived from the first member's `token`, so it is stable across passes for
   * the same reason `token` is: the group's answer is seeded from it (FR-080),
   * and a token that changed between passes would give the group a different
   * answer each time the page made us write it again.
   */
  readonly group?: string;
};

/**
 * A generated value, with the provenance that explains where it came from.
 *
 * A discriminated union rather than a bare string, because "the value" means
 * genuinely different things per control: text to write, options to select, a
 * box to tick. Collapsing those into a string would put the decision of how to
 * interpret it in the applier, where the generator's intent is no longer
 * available.
 */
export type FieldValue = {
  readonly ref: number;
  /**
   * Why this value: which rule matched and on which source. With no rules
   * configured this names the default generator instead — the field exists from
   * the start because a mis-fill nobody can explain is the defect ND-2
   * identifies (FR-069).
   */
  readonly provenance: string;
} & (
  | { readonly as: 'text'; readonly value: string }
  /** Options to select, by value. One for a radio or single select, any number for a multi-select. */
  | { readonly as: 'choice'; readonly values: readonly string[] }
  | { readonly as: 'toggle'; readonly checked: boolean }
  /**
   * A choice among options only the agent can see (FR-081).
   *
   * A custom combobox does not publish its options until it is opened, and
   * opening it is an interaction — so the background cannot be given a list to
   * choose from without the agent first touching the page. Rather than move
   * generation into the agent, or spend a second round trip per control, the
   * background sends the *draw* and the agent maps it onto whatever the control
   * turned out to offer.
   *
   * `at` is in [0, 1). It is a position in a list of unknown length, and it
   * carries no information about the page — which is what keeps this inside
   * DD-003 rather than an exception to it.
   *
   * FR-082 will want the option *labels*, to prefer the one matching the
   * persona. That needs either a second round trip or the agent describing the
   * control again once it is open, and is deliberately not decided here.
   */
  | { readonly as: 'pick'; readonly at: number }
  /** UC-004 A3.6: nothing selectable, so the control is left untouched. */
  | { readonly as: 'skip'; readonly reason: ExclusionReason }
);

/** What happened to one control. Exactly one outcome each (FR-009, ND-14). */
export type FieldOutcome =
  | { readonly ref: number; readonly status: 'filled'; readonly provenance: string }
  | { readonly ref: number; readonly status: 'skipped'; readonly reason: ExclusionReason }
  | { readonly ref: number; readonly status: 'failed'; readonly cause: string };

/**
 * Why a control was left alone. Machine-readable, and exactly one per control
 * — the first rule to fire wins, so a user debugging a skipped field gets one
 * answer rather than a set (BR-005-6, BR-005-8).
 */
export type ExclusionReason =
  | 'not-fillable-kind'
  | 'disabled'
  | 'readonly'
  | 'aria-disabled'
  /** Not perceivable to a sighted user — which includes every honeypot (UC-005 A3). */
  | 'hidden'
  /** Already holds user content, and the user asked for those to be left alone. */
  | 'pre-filled'
  | 'ignored-pattern'
  | 'no-selectable-option'
  /**
   * The user touched this control after the fill began, so nothing was written
   * to it (FR-079, BR-034-5). Distinct from `pre-filled`, which is about content
   * that was already there when the fill started.
   */
  | 'user-touched'
  /**
   * A custom combobox that neither the keyboard nor the pointer could drive to a
   * verified answer (UC-034 A10). The page was put back as it was found.
   */
  | 'combobox-not-driveable'
  /**
   * A custom combobox, with "skip pre-filled" on and no way to tell whether it
   * already holds an answer (BR-005-1). A native control exposes its value; a
   * `<div>` exposes rendered text, in which a chosen answer and a placeholder
   * look identical. Excluding is the fail-safe direction, and saying so is
   * better than reporting `pre-filled`, which would claim knowledge we do not
   * have.
   */
  | 'content-unknown'
  | 'unclassifiable';

/**
 * Why a cascade stopped before the page settled (FR-078, UC-034 A4).
 *
 * Reported as its own fact rather than folded into the counts. A fill that
 * stopped at a bound and one that finished are different results about the same
 * page, and a user who cannot tell them apart is back to the reference's problem
 * of not knowing whether anything went wrong (BR-034-6).
 */
export type CapReason =
  /** The pass cap was reached — the page and the engine could not agree. */
  | 'pass-cap'
  /** The total cascade budget was spent (NFR-034). */
  | 'time-budget'
  /** The user started working in the page, and outranks the fill (BR-034-5). */
  | 'user-input'
  /** A later pass could not obtain values — the background was evicted (A12). */
  | 'values-unavailable';

/**
 * Identifies one frame for the life of its page agent.
 *
 * Minted by the agent rather than derived from the frame's URL, because a URL is
 * not unique: two iframes with the same `src` are ordinary — the same embedded
 * form twice, or a frame showing the page that contains it — and every srcdoc
 * frame reports `about:srcdoc`. Keyed on the URL, the second such frame's report
 * is discarded as a duplicate: its outcomes go uncounted, and the frame it was
 * confused with closes the operation on its behalf. It is also what the
 * background waits on — a frame announces this token when it joins a fill, and
 * the fill is complete when every token that joined has reported.
 *
 * Carries no information about the page — it is a random token, not an address.
 */
export type FrameId = string;

/**
 * One frame's account of a fill. Frames report independently (BR-001-5).
 *
 * Sent once, when the frame's cascade has settled or stopped — not once per
 * pass. One outcome per control, decided last (BR-034-2).
 */
export type FrameReport = {
  readonly frame: FrameId;
  /** For the log and the report only; never used for identity. */
  readonly frameUrl: string;
  readonly outcomes: readonly FieldOutcome[];
  /** How many passes the frame made. Absent means one — see the module note. */
  readonly passes?: number;
  /** Present only when the frame stopped at a bound rather than settling. */
  readonly capped?: CapReason;
  /**
   * How many controls the next pass would have worked on when the bound was
   * reached — the "may be stale" figure FR-078 requires. Absent unless `capped`.
   */
  readonly stale?: number;
  /**
   * Which rule of DD-008's ladder decided this frame's scope (BR-002-4).
   *
   * A Tester surprised by where the boundary fell needs to know why it fell
   * there, which is the argument provenance makes for values (FR-069) applied
   * to the scope. Absent from an agent that predates Phase 3, which only ever
   * filled the page.
   */
  readonly scopeRule?: ScopeRule;
  /**
   * Set when the frame declined to fill anything, and why (UC-002 A3, UC-003 A2).
   *
   * Distinct from an empty `outcomes` list, which means "I looked and found
   * nothing fillable" — a different sentence, and a different thing to tell the
   * user. Refusing to widen a scope the user narrowed is a decision, not a
   * shortage of controls.
   */
  readonly refused?: ScopeRefusal;
};

/** Which rule of DD-008's ladder resolved a fill's scope (UC-002, UC-003). */
export type ScopeRule =
  | 'element-form'
  | 'role-form'
  | 'submit-container'
  | 'only-unit'
  | 'whole-page'
  | 'anchor-control';

export type ScopeRefusal = 'no-form-around-anchor' | 'no-anchor';

/**
 * One control's line in the fill report (DD-006, FR-009, FR-069).
 *
 * Lives here rather than beside the code that assembles it because it crosses a
 * message boundary — the options page receives it — and everything that crosses
 * a boundary is defined in one place.
 *
 * `identity` is page-derived, and `lib/report/surface.ts` documents in full what
 * that permits: memory only, one fill's worth, never written to storage. There
 * is deliberately no field for the control's *value*, here or anywhere: a
 * descriptor has never carried one (BR-004-10, NFR-030) and provenance says how
 * a value was chosen, not what it was.
 */
export type FieldReportEntry = {
  readonly frame: FrameId;
  readonly ref: number;
  /** How the user would name this field — its label, or the nearest thing to one. */
  readonly identity: string;
  readonly kind: ControlKind;
  readonly status: 'filled' | 'skipped' | 'failed';
  /** Provenance for a filled control, the reason or cause otherwise (FR-069). */
  readonly detail: string;
};

export type OutcomeCounts = { filled: number; skipped: number; failed: number };

/** A whole fill, across every frame that took part (BR-001-5). */
export type FillReport = {
  readonly scope: FillScope;
  /** When the fill finished, so the options page can say how old this is. */
  readonly finishedAt: number;
  readonly counts: OutcomeCounts;
  /** Absent when the fill settled rather than stopping at a bound (FR-078). */
  readonly capped: CapReason | undefined;
  readonly stale: number;
  /** Rules that could not run, by label and reason (DD-005). */
  readonly skippedRules: readonly string[];
  /**
   * Set when the scope refused to resolve, and why (UC-002 A3, UC-003 A2).
   *
   * Distinct from a fill that found nothing: refusing to widen a scope the user
   * narrowed is a decision, and it gets its own sentence.
   */
  readonly refused: ScopeRefusal | undefined;
  /**
   * Which rung of DD-008's ladder resolved the scope (BR-002-4).
   *
   * A ladder is only better than a heuristic if its answer is inspectable, which
   * is ND-2's argument applied to scopes rather than rules. Absent when no
   * ladder ran — the page scope, and a fill that refused.
   */
  readonly scopeRule: ScopeRule | undefined;
  readonly fields: readonly FieldReportEntry[];
};

export type ToAgentMessage =
  | { readonly kind: 'ping' }
  | {
      readonly kind: 'fill';
      readonly operationId: OperationId;
      readonly scope: FillScope;
      /** Which channel invoked this fill, and so where the anchor comes from. */
      readonly trigger: FillTrigger;
      /** Only the settings this agent's own work requires (BR-024-4). */
      readonly settings: AgentSettings;
    };

export type FromAgentMessage =
  | { readonly kind: 'pong'; readonly frameUrl: string }
  /**
   * Sent synchronously when a fill instruction arrives, before the walk starts.
   *
   * Its only job is to make the sender's promise resolve with something. A
   * listener that answers nothing leaves the reply unspecified — measured on
   * Chrome 151 it resolves with `undefined`, which is indistinguishable from an
   * agent that ignored the message, and the behaviour is not guaranteed to be
   * the same on Firefox or in a later Chrome. Acknowledging turns "did anything
   * receive this?" from an inference into an answer.
   */
  | { readonly kind: 'accepted'; readonly frame: FrameId }
  /**
   * Sent by every frame that takes up a fill, immediately and once.
   *
   * `tabs.sendMessage` broadcasts to every frame but returns a single reply, so
   * `accepted` tells the background only that *somebody* heard it. This tells it
   * *who* — which is the difference between knowing a fill is complete and
   * inferring it from the reports having gone quiet.
   *
   * That inference was sound while a fill was one walk and every frame reported
   * within milliseconds of the others. DD-009 made a frame's duration depend on
   * how much its own page cascades, so two frames in one tab can now finish
   * seconds apart, and a window short enough to feel responsive drops the slower
   * one's outcomes. Frames still cannot see each other; each simply says that it
   * is participating.
   */
  | { readonly kind: 'joined'; readonly operationId: OperationId; readonly frame: FrameId }
  /** The descriptor batch — the request half of the single round trip. */
  | {
      readonly kind: 'descriptors';
      readonly operationId: OperationId;
      /**
       * Which frame is asking (DD-006).
       *
       * Optional, like `token` and `passes` before it, because an agent injected
       * before this build keeps running until its tab reloads and its batches
       * must still validate. Its absence costs only the report: refs from an
       * agent that does not identify itself cannot be joined to a name, and
       * those rows say so rather than guessing.
       */
      readonly frame?: FrameId;
      readonly descriptors: readonly FieldDescriptor[];
    }
  | { readonly kind: 'report'; readonly operationId: OperationId; readonly report: FrameReport };

/** The background's reply to a descriptor batch. */
export type ValuesResponse = {
  readonly kind: 'values';
  readonly operationId: OperationId;
  readonly values: readonly FieldValue[];
};

/**
 * Sent by the options page to fetch the last fill's report (DD-006).
 *
 * A separate union from `FromAgentMessage` on purpose: this comes from an
 * extension page, which is our own code and a different trust position from a
 * content script sharing a process with a hostile document. Merging the two
 * would let a compromised page agent ask for a report it has no business
 * reading — the report covers every frame, and one frame's agent may see only
 * its own.
 */
export type FromPageMessage = { readonly kind: 'report-request' };

/**
 * The answer, which is legitimately "nothing".
 *
 * The report lives in the background's memory and the background is evicted
 * routinely, so having no report is an ordinary outcome rather than an error —
 * and the options page says so in those terms rather than rendering an empty
 * table (DD-006, NFR-020).
 */
export type ReportResponse = {
  readonly kind: 'report-response';
  readonly report: FillReport | undefined;
};

/**
 * The slice of settings a page agent needs to do its own work (BR-024-4).
 *
 * It is never sent the rule list, the generators or the profiles, because it
 * never uses them: less crosses the boundary, and less is exposed if a page ever
 * compromises the agent. Domain exclusions stay out of it for a different
 * reason than the rest: the agent is never told a domain is excluded, because
 * BR-008-1 settles that in the background before any frame is contacted, and an
 * excluded page must not be able to learn the extension exists by being asked.
 */
export type AgentSettings = {
  /** UC-004 A8: the user may turn the interaction sequence off entirely. */
  readonly dispatchEvents: boolean;
  /** UC-005 step 6. Off means honeypots get filled, which is the point of it. */
  readonly skipHidden: boolean;
  /** UC-005 step 7. Our own earlier writes never count as content (BR-005-7). */
  readonly skipPreFilled: boolean;
  /**
   * Patterns whose match excludes a control (UC-005 step 5).
   *
   * Sent as source strings and compiled once by the agent, never per field per
   * pattern (ND-15, NFR-025). An invalid pattern is skipped rather than fatal
   * (UC-005 A5).
   */
  readonly ignorePatterns: readonly string[];
};

export const PING: ToAgentMessage = { kind: 'ping' };

/**
 * Narrows an untrusted `unknown` from the messaging channel.
 *
 * Extension messages arrive untyped, and while a page cannot send them, a page
 * agent left over from a previous extension version can — so neither side may
 * assume the other is the same build.
 */
export function isFillTrigger(value: unknown): value is FillTrigger {
  return typeof value === 'string' && (FILL_TRIGGERS as readonly string[]).includes(value);
}

export function isToAgentMessage(value: unknown): value is ToAgentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'ping') return true;
  if (kind !== 'fill') return false;
  // A fill that does not say how it was invoked cannot be acted on: the trigger
  // is what decides whether the anchor is the element under the pointer or the
  // one holding focus, and guessing is the defect this field was added to fix.
  // Refusing here costs a fill that the background's own timeout will clear;
  // guessing costs the user a form filled somewhere they were not looking.
  return isFillTrigger((value as { trigger?: unknown }).trigger);
}

/**
 * Narrowed against `Record<string, unknown>` rather than a `Partial<…>` of the
 * target type. A `Partial` cast asserts that every property already has the
 * declared type and only might be absent, which is the one thing a validator may
 * not assume — and it quietly makes a `!== null` guard look redundant to the
 * type checker while remaining essential at runtime, since `typeof null` is
 * `"object"`.
 */
function isDescriptor(value: unknown): value is FieldDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['ref'] === 'number' &&
    typeof candidate['kind'] === 'string' &&
    typeof candidate['sources'] === 'object' &&
    candidate['sources'] !== null &&
    typeof candidate['constraints'] === 'object' &&
    candidate['constraints'] !== null
  );
}

const OUTCOME_STATUSES = new Set(['filled', 'skipped', 'failed']);

function isOutcome(value: unknown): value is FieldOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['ref'] === 'number' &&
    typeof candidate['status'] === 'string' &&
    OUTCOME_STATUSES.has(candidate['status'])
  );
}

const CAP_REASONS = new Set(['pass-cap', 'time-budget', 'user-input', 'values-unavailable']);

const SCOPE_REFUSALS: ReadonlySet<string> = new Set<ScopeRefusal>([
  'no-form-around-anchor',
  'no-anchor',
]);

const SCOPE_RULES: ReadonlySet<string> = new Set<ScopeRule>([
  'element-form',
  'role-form',
  'submit-container',
  'only-unit',
  'whole-page',
  'anchor-control',
]);

function isFrameReport(value: unknown): value is FrameReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['frame'] === 'string' &&
    typeof candidate['frameUrl'] === 'string' &&
    Array.isArray(candidate['outcomes']) &&
    // Each outcome, not just the array. A report from an older agent could carry
    // a status this version does not know, and the whole point of validating at
    // the boundary is that nothing downstream has to wonder.
    candidate['outcomes'].every(isOutcome) &&
    // The DD-009 fields, absent from every agent built before the loop. Checked
    // only when present, which is what makes the growth compatible: a report
    // from a tab that has not reloaded since the update still validates, and
    // reads as the single-pass fill it was.
    (candidate['passes'] === undefined || typeof candidate['passes'] === 'number') &&
    (candidate['capped'] === undefined ||
      (typeof candidate['capped'] === 'string' && CAP_REASONS.has(candidate['capped']))) &&
    (candidate['stale'] === undefined || typeof candidate['stale'] === 'number') &&
    // The DD-008 fields, on the same terms as the DD-009 ones above: optional
    // because an agent from before the scopes existed sends neither, and checked
    // against their own vocabularies because both reach a user-facing surface.
    // `refused` picks the sentence the user reads and `scopeRule` names a rung of
    // the ladder; an unrecognised value in either would be shown, or silently
    // change which sentence is shown, which is what validating here prevents.
    (candidate['refused'] === undefined ||
      (typeof candidate['refused'] === 'string' && SCOPE_REFUSALS.has(candidate['refused']))) &&
    (candidate['scopeRule'] === undefined ||
      (typeof candidate['scopeRule'] === 'string' && SCOPE_RULES.has(candidate['scopeRule'])))
  );
}

/**
 * Narrows a message arriving at the background from a page agent.
 *
 * Worth validating rather than casting. The agent is our own code, but it is not
 * necessarily our own *version*: after an update, tabs opened beforehand still
 * run the previous build until they reload, so the background must treat the
 * shape as a claim rather than a guarantee.
 */
export function isFromAgentMessage(value: unknown): value is FromAgentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    kind?: unknown;
    operationId?: unknown;
    descriptors?: unknown;
    report?: unknown;
    frameUrl?: unknown;
    frame?: unknown;
  };

  switch (candidate.kind) {
    case 'pong':
      return typeof candidate.frameUrl === 'string';
    case 'accepted':
      return typeof candidate.frame === 'string';
    case 'joined':
      return typeof candidate.operationId === 'string' && typeof candidate.frame === 'string';
    case 'descriptors':
      return (
        typeof candidate.operationId === 'string' &&
        Array.isArray(candidate.descriptors) &&
        candidate.descriptors.every(isDescriptor)
      );
    case 'report':
      return typeof candidate.operationId === 'string' && isFrameReport(candidate.report);
    default:
      return false;
  }
}

export function isValuesResponse(value: unknown): value is ValuesResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; values?: unknown };
  return candidate.kind === 'values' && Array.isArray(candidate.values);
}
