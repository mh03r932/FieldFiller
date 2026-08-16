import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import {
  badgeFor,
  fieldsFromReport,
  identityOf,
  noteDescriptors,
  resultSentence,
  scopeRuleSentence,
  type FieldNotes,
  type ResultMessageKey,
} from '@/lib/report/surface';
import type { FieldDescriptor, FillReport, FrameReport } from '@/lib/protocol';

/**
 * DD-006 — the result surface.
 *
 * The rendering is in the options page; what is asserted here is everything that
 * decides *what* it renders, which is where a wrong answer would be invisible.
 */

function fragment(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function descriptorFor(html: string, ref = 0): FieldDescriptor {
  const element = collectCandidates(fragment(html))[0]!;
  const classification = classifyStructural(element, {
    skipHidden: false,
    skipPreFilled: false,
    writtenByUs: new WeakSet<Element>(),
  });
  if (!classification.fillable) throw new Error(`excluded: ${classification.reason}`);
  return describeField(element, ref, classification.kind);
}

/** Echoes the key and its substitutions, so a test asserts structure not wording. */
const echo = (key: ResultMessageKey, substitutions?: readonly string[]): string =>
  substitutions === undefined ? `[${key}]` : `[${key}:${substitutions.join('|')}]`;

function report(overrides: Partial<FillReport> = {}): FillReport {
  return {
    scope: 'all-inputs',
    finishedAt: 0,
    counts: { filled: 6, skipped: 1, failed: 0 },
    capped: undefined,
    stale: 0,
    skippedRules: [],
    refused: undefined,
    scopeRule: undefined,
    fields: [],
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('naming a field to a person', () => {
  it('prefers what the user reads over what the developer wrote', () => {
    expect(
      identityOf(descriptorFor('<label>Email address<input name="e_1" id="x"></label>')),
    ).toBe('Email address');
    expect(identityOf(descriptorFor('<input aria-label="Postcode" name="pc">'))).toBe('Postcode');
    expect(identityOf(descriptorFor('<input placeholder="Your town" name="t">'))).toBe('Your town');
    expect(identityOf(descriptorFor('<input name="given_name">'))).toBe('given_name');
    expect(identityOf(descriptorFor('<input id="lastName">'))).toBe('lastName');
  });

  it('never names a field by its class attribute', () => {
    // A class identifies a style, not a field. It is also the noisiest source
    // there is (FR-027), and a row headed `form-control mt-2` names nothing.
    expect(identityOf(descriptorFor('<input class="form-control mt-2">'))).toBe('text field');
  });

  it('ignores an identity that is only whitespace', () => {
    expect(identityOf(descriptorFor('<input aria-label="   " name="real">'))).toBe('real');
  });
});

describe('joining outcomes to what was described', () => {
  it('keeps two frames’ refs apart', () => {
    // Refs are only unique within a frame: both frames start at zero, and a flat
    // key would let one frame's fields be reported under the other's names.
    const notes: FieldNotes = new Map();
    noteDescriptors(notes, 'frame-a', [descriptorFor('<input name="alpha">', 0)]);
    noteDescriptors(notes, 'frame-b', [descriptorFor('<input name="beta">', 0)]);

    const rows = fieldsFromReport(notes, {
      frame: 'frame-b',
      frameUrl: 'https://example.test/',
      outcomes: [{ ref: 0, status: 'filled', provenance: 'identity → persona.x' }],
    } satisfies FrameReport);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.identity).toBe('beta');
  });

  it('carries the provenance for a filled field and the reason otherwise', () => {
    const notes: FieldNotes = new Map();
    noteDescriptors(notes, 'f', [
      descriptorFor('<input name="one">', 0),
      descriptorFor('<input name="two">', 1),
      descriptorFor('<input name="three">', 2),
    ]);

    const rows = fieldsFromReport(notes, {
      frame: 'f',
      frameUrl: 'https://example.test/',
      outcomes: [
        { ref: 0, status: 'filled', provenance: 'autocomplete="email" → persona.email' },
        { ref: 1, status: 'skipped', reason: 'hidden' },
        { ref: 2, status: 'failed', cause: 'write-not-observed' },
      ],
    } satisfies FrameReport);

    expect(rows.map((row) => [row.identity, row.status, row.detail])).toEqual([
      ['one', 'filled', 'autocomplete="email" → persona.email'],
      ['two', 'skipped', 'hidden'],
      ['three', 'failed', 'write-not-observed'],
    ]);
  });

  it('shows a row for an outcome it cannot name rather than dropping it', () => {
    // An outcome with no matching descriptor means the agent reported a control
    // it never described. That should not happen, which is exactly why it must
    // be visible — a silently missing row is how a reporting bug survives.
    const rows = fieldsFromReport(new Map(), {
      frame: 'f',
      frameUrl: 'https://example.test/',
      outcomes: [{ ref: 9, status: 'filled', provenance: 'whatever' }],
    } satisfies FrameReport);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.identity).toBe('unknown field');
  });

  it('takes the latest description of a control the page changed', () => {
    // UC-034: a control described again in a later pass may have been relabelled
    // or replaced. The report should say what it was when the fill ended.
    const notes: FieldNotes = new Map();
    noteDescriptors(notes, 'f', [descriptorFor('<input name="before">', 0)]);
    document.body.innerHTML = '';
    noteDescriptors(notes, 'f', [descriptorFor('<input name="after">', 0)]);

    const rows = fieldsFromReport(notes, {
      frame: 'f',
      frameUrl: 'https://example.test/',
      outcomes: [{ ref: 0, status: 'filled', provenance: 'p' }],
    } satisfies FrameReport);

    expect(rows[0]!.identity).toBe('after');
  });
});

describe('the badge (DD-006)', () => {
  it('marks a capped fill so a keyboard-only user can see it', () => {
    // The tooltip is hover-only, which DD-006 names as its known weakness. The
    // marker is what that user gets instead, so a capped fill must not be
    // indistinguishable from a settled one on the badge alone.
    const settled = badgeFor({ filled: 6, skipped: 0, failed: 0 }, undefined);
    const capped = badgeFor({ filled: 6, skipped: 0, failed: 0 }, 'pass-cap');

    expect(settled.text).toBe('6');
    expect(capped.text).not.toBe(settled.text);
    expect(capped.colour).not.toBe(settled.colour);
  });

  it('lets a definite failure outrank an uncertain cap', () => {
    const both = badgeFor({ filled: 6, skipped: 0, failed: 2 }, 'pass-cap');
    const cappedOnly = badgeFor({ filled: 6, skipped: 0, failed: 0 }, 'pass-cap');
    expect(both.colour).not.toBe(cappedOnly.colour);
  });

  it('does not mark a failure, only a cap', () => {
    // DD-006 scopes the marker to a capped fill. A failure does not make the
    // count untrue — "6 filled" holds whether or not two others failed — where a
    // capped fill makes the count itself provisional. Marking both would also
    // make the badge unreadable as a number, which is what the end-to-end
    // harnesses read it as.
    expect(badgeFor({ filled: 6, skipped: 0, failed: 2 }, undefined).text).toBe('6');
    expect(badgeFor({ filled: 6, skipped: 0, failed: 2 }, 'pass-cap').text).toBe('6!');
  });

  it('distinguishes nothing to fill from nothing filled', () => {
    // BR-001-4: a page with no fillable controls is a success, and must not look
    // like a failure.
    const empty = badgeFor({ filled: 0, skipped: 0, failed: 0 }, undefined);
    expect(empty.text).toBe('0');
    expect(empty.colour).not.toBe(badgeFor({ filled: 3, skipped: 0, failed: 0 }, undefined).colour);
  });
});

describe('the result sentence (DD-006)', () => {
  it('names the scope, which is the reason it exists', () => {
    // "6 filled" reads identically for a form and for a whole page (DD-008).
    expect(resultSentence(report({ scope: 'all-inputs' }), echo)).toContain('resultScopeAllInputs');
    expect(resultSentence(report({ scope: 'current-form' }), echo)).toContain('resultScopeCurrentForm');
    expect(resultSentence(report({ scope: 'selected-input' }), echo)).toContain('resultScopeSelectedInput');
  });

  it('says how many and, when capped, how many may be stale', () => {
    expect(resultSentence(report(), echo)).toBe('[resultSettled:6|[resultScopeAllInputs]]');

    const capped = resultSentence(report({ capped: 'user-input', stale: 2 }), echo);
    expect(capped).toContain('resultCapped:6|');
    expect(capped).toContain('|2|');
    expect(capped).toContain('resultCapUserInput');
  });

  it.each([
    ['pass-cap', 'resultCapPassCap'],
    ['time-budget', 'resultCapTimeBudget'],
    ['values-unavailable', 'resultCapValuesUnavailable'],
    ['user-input', 'resultCapUserInput'],
  ] as const)('explains %s in the user’s terms', (reason, key) => {
    expect(resultSentence(report({ capped: reason, stale: 1 }), echo)).toContain(key);
  });

  it('appends a rule that could not run, and only when there is one', () => {
    expect(resultSentence(report(), echo)).not.toContain('resultRulesSkipped');

    const withRules = resultSentence(
      report({ skippedRules: ['postcode: invalid pattern', 'phone: bad template'] }),
      echo,
    );
    expect(withRules).toContain('resultRulesSkipped:2|');
    expect(withRules).toContain('postcode: invalid pattern; phone: bad template');
  });
});

describe('naming the rung that resolved the scope (BR-002-4)', () => {
  // ND-2's argument applied to scopes: a ladder is only better than a heuristic
  // if the answer is inspectable. The rung reached the protocol long before it
  // reached a surface — the agent sent it, the background dropped it, and
  // UC-002's postcondition went unmet with the field sitting there unread.
  it.each([
    ['element-form', 'resultRuleElementForm'],
    ['role-form', 'resultRuleRoleForm'],
    ['submit-container', 'resultRuleSubmitContainer'],
    ['only-unit', 'resultRuleOnlyUnit'],
    ['whole-page', 'resultRuleWholePage'],
    ['anchor-control', 'resultRuleAnchorControl'],
  ] as const)('names %s', (rule, key) => {
    expect(scopeRuleSentence(report({ scopeRule: rule }), echo)).toBe(
      `[reportScopeChosenBy:[${key}]]`,
    );
  });

  it('says nothing when no rung ran', () => {
    expect(scopeRuleSentence(report({ scopeRule: undefined }), echo)).toBeUndefined();
  });

  it('says nothing about a fill that refused', () => {
    // A refusal has no scope to explain, and its own sentence explains more.
    expect(
      scopeRuleSentence(report({ refused: 'no-form-around-anchor', scopeRule: 'whole-page' }), echo),
    ).toBeUndefined();
  });
});

describe('a refusal is not an empty fill, on every surface (DD-006)', () => {
  // The options page kept a second copy of this sentence that never learned
  // about refusals, so a fill that refused to guess which form was meant was
  // reported there as a form with nothing in it. Both surfaces call this now,
  // and the test is what keeps a third copy from being written.
  it.each([
    ['no-anchor', 'resultRefusedNoAnchor'],
    ['no-form-around-anchor', 'resultRefusedNoForm'],
  ] as const)('reports %s as a refusal rather than a count', (refusal, key) => {
    const sentence = resultSentence(report({ refused: refusal, counts: { filled: 0, skipped: 0, failed: 0 } }), echo);
    expect(sentence).toBe(`[${key}]`);
    expect(sentence).not.toContain('resultSettled');
  });
});
