/**
 * The background ↔ page-agent message protocol.
 *
 * Platform-free by construction: no `chrome.*`, no `browser.*`, no DOM. Both
 * sides of the boundary import it (NFR-015).
 *
 * The shape follows DD-003. The agent walks and applies but carries no corpus,
 * so one fill costs exactly one round trip: descriptors out, values back
 * (NFR-029). The background sends the initial instruction, which is what lets
 * the persona exist before any frame is asked for anything (BR-004-1a).
 */

/** The three fill scopes. Phase 1 implements only `all-inputs` (UC-001). */
export type FillScope = 'all-inputs' | 'current-form' | 'selected-input';

/**
 * Identifies one fill operation across every message and every frame it touches.
 *
 * A page and its frames are one fill sharing one persona (BR-001-1). Frames
 * cannot talk to each other, so the operation id is what ties their independent
 * exchanges to the same person.
 */
export type OperationId = string;

/** The kinds of control Phase 1 can fill. Phase 2 brings the rest. */
export type ControlKind = 'text' | 'email' | 'tel' | 'url' | 'search' | 'password' | 'textarea';

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
  /** Positional handle, unique within the frame, for pairing values back up. */
  readonly ref: number;
  readonly kind: ControlKind;
  readonly sources: {
    readonly name?: string;
    readonly id?: string;
    readonly label?: string;
    readonly placeholder?: string;
    readonly ariaLabel?: string;
  };
  /** The `autocomplete` token, a better identity signal than a regex on `id`. */
  readonly autocomplete?: string;
  readonly constraints: {
    readonly maxLength?: number;
    readonly minLength?: number;
  };
};

/** A generated value, with the provenance that explains where it came from. */
export type FieldValue = {
  readonly ref: number;
  readonly value: string;
  /**
   * Why this value: which rule matched and on which source. Phase 1 has no
   * rules, so this names the default generator that was chosen instead — the
   * field exists from the start because a mis-fill nobody can explain is the
   * defect ND-2 identifies (FR-069).
   */
  readonly provenance: string;
};

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
  | 'unclassifiable';

/** One frame's account of a fill. Frames report independently (BR-001-5). */
export type FrameReport = {
  readonly frameUrl: string;
  readonly outcomes: readonly FieldOutcome[];
};

export type ToAgentMessage =
  | { readonly kind: 'ping' }
  | {
      readonly kind: 'fill';
      readonly operationId: OperationId;
      readonly scope: FillScope;
      /** Only the settings this agent's own work requires (BR-024-4). */
      readonly settings: AgentSettings;
    };

export type FromAgentMessage =
  | { readonly kind: 'pong'; readonly frameUrl: string }
  /** The descriptor batch — the request half of the single round trip. */
  | {
      readonly kind: 'descriptors';
      readonly operationId: OperationId;
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
 * The slice of settings a page agent needs to do its own work (BR-024-4).
 *
 * It is never sent the rule list, the generators or the profiles, because it
 * never uses them: less crosses the boundary, and less is exposed if a page ever
 * compromises the agent. Phase 4 grows this with the exclusion toggles, ignore
 * patterns and domain exclusions.
 */
export type AgentSettings = {
  /** UC-004 A8: the user may turn the interaction sequence off entirely. */
  readonly dispatchEvents: boolean;
};

export const PING: ToAgentMessage = { kind: 'ping' };

/**
 * Narrows an untrusted `unknown` from the messaging channel.
 *
 * Extension messages arrive untyped, and while a page cannot send them, a page
 * agent left over from a previous extension version can — so neither side may
 * assume the other is the same build.
 */
export function isToAgentMessage(value: unknown): value is ToAgentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ping' || kind === 'fill';
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

function isFrameReport(value: unknown): value is FrameReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['frameUrl'] === 'string' && Array.isArray(candidate['outcomes']);
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
  };

  switch (candidate.kind) {
    case 'pong':
      return typeof candidate.frameUrl === 'string';
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
