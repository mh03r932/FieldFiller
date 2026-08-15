import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural, radioGroup } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { applyValue } from '@/lib/page/apply';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { generateValue } from '@/lib/generators/default-generator';
import { generateBatch } from '@/lib/generators/batch';
import type { ControlKind, FieldDescriptor, FieldValue } from '@/lib/protocol';

/** Phase 2: every control kind, the full exclusion set, and confirmation fields. */

function fragment(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

const context = (overrides: Partial<{ skipHidden: boolean; skipPreFilled: boolean }> = {}) => ({
  skipHidden: false,
  skipPreFilled: false,
  writtenByUs: new WeakSet<Element>(),
  ...overrides,
});

function only(html: string): Element {
  return collectCandidates(fragment(html))[0]!;
}

function descriptorFor(html: string): FieldDescriptor {
  const element = only(html);
  const classification = classifyStructural(element, context());
  if (!classification.fillable) throw new Error(`excluded: ${classification.reason}`);
  return describeField(element, 0, classification.kind);
}

const persona = createPersona(seededRandom(11));
const random = seededRandom(11);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('control kinds', () => {
  it.each([
    ['<input type="number">', 'number'],
    ['<input type="range">', 'range'],
    ['<input type="date">', 'date'],
    ['<input type="datetime-local">', 'datetime-local'],
    ['<input type="month">', 'month'],
    ['<input type="week">', 'week'],
    ['<input type="time">', 'time'],
    ['<input type="color">', 'color'],
    ['<input type="checkbox">', 'checkbox'],
    ['<input type="radio">', 'radio'],
    ['<select><option>a</option></select>', 'select-one'],
    ['<select multiple><option>a</option></select>', 'select-multiple'],
    ['<div contenteditable="true"></div>', 'contenteditable'],
  ])('recognises %s', (html, kind) => {
    expect(classifyStructural(only(html), context())).toEqual({ fillable: true, kind });
  });
});

describe('native constraints (D9)', () => {
  it('generates a number inside min/max and snapped to step', () => {
    // The reference supports none of these, so it produces values the page's own
    // validation rejects — which defeats the point of filling the form.
    for (let seed = 0; seed < 40; seed++) {
      const value = generateValue(
        descriptorFor('<input type="number" min="10" max="20" step="5">'),
        persona,
        seededRandom(seed),
      );
      const numeric = Number(value.as === 'text' ? value.value : NaN);
      expect(numeric).toBeGreaterThanOrEqual(10);
      expect(numeric).toBeLessThanOrEqual(20);
      expect((numeric - 10) % 5).toBe(0);
    }
  });

  it('generates a date the browser will accept', () => {
    const value = generateValue(descriptorFor('<input type="date">'), persona, random);
    expect(value.as === 'text' && value.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never invents a 31st of February', () => {
    for (let seed = 0; seed < 100; seed++) {
      const value = generateValue(descriptorFor('<input type="date">'), persona, seededRandom(seed));
      const day = Number(String(value.as === 'text' ? value.value : '').slice(-2));
      expect(day).toBeLessThanOrEqual(28);
    }
  });

  it('generates a colour in the only format the control accepts', () => {
    const value = generateValue(descriptorFor('<input type="color">'), persona, random);
    expect(value.as === 'text' && value.value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('options (D3)', () => {
  const select = '<select><option value="">Choose…</option><option value="a">A</option><option value="b" disabled>B</option></select>';

  it('reports every option with its disabled state', () => {
    expect(descriptorFor(select).options).toEqual([
      { value: '', label: 'Choose…', disabled: false },
      { value: 'a', label: 'A', disabled: false },
      { value: 'b', label: 'B', disabled: true },
    ]);
  });

  it('never selects a disabled option, and never the empty placeholder', () => {
    // D3: the reference tests option `i` for `disabled` then selects a
    // *different* random index, so it picks disabled options — and can never
    // pick option 0.
    for (let seed = 0; seed < 60; seed++) {
      const value = generateValue(descriptorFor(select), persona, seededRandom(seed));
      expect(value.as).toBe('choice');
      if (value.as === 'choice') expect(value.values).toEqual(['a']);
    }
  });

  it('can select the last option, which the reference cannot reach', () => {
    // D7's index arithmetic applied to options.
    const three = '<select><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>';
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const value = generateValue(descriptorFor(three), persona, seededRandom(seed));
      if (value.as === 'choice') seen.add(value.values[0]!);
    }
    expect(seen).toEqual(new Set(['x', 'y', 'z']));
  });

  it('skips a control whose every option is disabled, with a reason', () => {
    // UC-004 A3.6 — left untouched rather than filled with something invalid.
    const value = generateValue(
      descriptorFor('<select><option value="a" disabled>A</option></select>'),
      persona,
      random,
    );
    expect(value.as).toBe('skip');
    if (value.as === 'skip') expect(value.reason).toBe('no-selectable-option');
  });

  it('picks at least one and at most all options of a multi-select', () => {
    const multi = '<select multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>';
    for (let seed = 0; seed < 50; seed++) {
      const value = generateValue(descriptorFor(multi), persona, seededRandom(seed));
      if (value.as !== 'choice') throw new Error('expected a choice');
      expect(value.values.length).toBeGreaterThanOrEqual(1);
      expect(value.values.length).toBeLessThanOrEqual(3);
      // Each chosen at most once.
      expect(new Set(value.values).size).toBe(value.values.length);
    }
  });
});

/**
 * A radio group is one decision, not one decision per button.
 *
 * These generate for every member and apply every result, because that is the
 * only arrangement in which the bug was visible: each member carries the whole
 * group's options, so generating per descriptor makes the members disagree — and
 * since applying a choice means "tick me if I am the chosen one", two members
 * choosing each other leave nothing ticked at all.
 *
 * The earlier test missed it by handing both radios the same `values`, which is
 * the answer the fix produces. It asserted the conclusion instead of deriving it.
 */
describe('radio groups are decided once per group', () => {
  const groupPersona = createPersona(seededRandom(5));

  /** What `generateBatch` does in the background: one answer per group token. */
  function fillGroup(html: string, seed: number): HTMLInputElement[] {
    const root = fragment(html);
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const random = seededRandom(seed);

    // Mirrors the agent exactly: an excluded member never becomes a descriptor
    // and is never applied to, but a disabled radio is still *listed* in the
    // group's options — so the generator has to be what refuses to pick it.
    //
    // Critically, this calls the real `generateBatch` over the whole set rather
    // than generating once and fanning the answer out by hand. Restating the fix
    // in the test is how the original bug survived its own test: the grouping is
    // the thing under test, so the test must not perform it.
    const fillable = radios.flatMap((radio, index) => {
      const classification = classifyStructural(radio, context());
      if (!classification.fillable) return [];
      return [
        { radio, descriptor: describeField(radio, index, classification.kind, { group: 'group-0' }) },
      ];
    });

    const values = generateBatch(
      fillable.map((entry) => entry.descriptor),
      { persona: groupPersona, randomFor: () => random },
    );
    for (const [index, entry] of fillable.entries()) {
      applyValue(entry.radio, values[index]!, { dispatchEvents: true });
    }
    return radios;
  }

  it.each([2, 3, 5])('always selects exactly one of %i options', (count) => {
    const html = `<form>${Array.from(
      { length: count },
      (_, index) => `<input type="radio" name="pick" value="v${index}">`,
    ).join('')}</form>`;

    // Every seed in a range, not a sample: the failure this guards against was
    // stochastic, and a stochastic test for a stochastic bug is how it survived
    // the first time.
    for (let seed = 0; seed < 300; seed++) {
      const radios = fillGroup(html, seed);
      const checked = radios.filter((radio) => radio.checked);
      expect(checked, `seed ${seed} selected ${checked.length}`).toHaveLength(1);
    }
  });

  it('never selects a disabled member', () => {
    for (let seed = 0; seed < 200; seed++) {
      const radios = fillGroup(
        '<form><input type="radio" name="p" value="a"><input type="radio" name="p" value="b" disabled></form>',
        seed,
      );
      expect(radios[1]!.checked).toBe(false);
    }
  });
});

describe('radio groups (BR-005-3, ND-5)', () => {
  it('scopes a group to its own form, not the document', () => {
    // The reference searches the whole document, so two forms using the same
    // group name interfere with each other.
    const root = fragment(`
      <form id="one"><input type="radio" name="contact" value="email"><input type="radio" name="contact" value="post"></form>
      <form id="two"><input type="radio" name="contact" value="phone"></form>
    `);
    const first = root.querySelector<HTMLInputElement>('#one input')!;
    expect(radioGroup(first).map((radio) => radio.value)).toEqual(['email', 'post']);
  });

  it('falls back to the document for a radio with no form', () => {
    // Which is what the browser itself does when deciding mutual exclusivity.
    const root = fragment('<input type="radio" name="loose" value="a"><input type="radio" name="loose" value="b">');
    expect(radioGroup(root.querySelector<HTMLInputElement>('input')!)).toHaveLength(2);
  });
});

describe('hidden and honeypot exclusion (UC-005 A3, ND-16)', () => {
  it.each([
    ['display:none', 'display:none'],
    ['visibility:hidden', 'visibility:hidden'],
    ['zero opacity', 'opacity:0'],
  ])('excludes a control hidden by %s', (_label, style) => {
    const element = only(`<input style="${style}">`);
    expect(classifyStructural(element, context({ skipHidden: true }))).toEqual({
      fillable: false,
      reason: 'hidden',
    });
  });

  it('fills a hidden control when the user has turned the check off', () => {
    const element = only('<input style="display:none">');
    expect(classifyStructural(element, context({ skipHidden: false })).fillable).toBe(true);
  });
});

describe('pre-filled exclusion (UC-005 step 7)', () => {
  it('excludes a control that already holds a value', () => {
    const element = only('<input value="typed by the user">');
    expect(classifyStructural(element, context({ skipPreFilled: true }))).toEqual({
      fillable: false,
      reason: 'pre-filled',
    });
  });

  it('does not treat a checkbox state as content', () => {
    // BR-005-2: an unchecked box is indistinguishable from an untouched one, so
    // treating state as content would disable checkbox filling entirely.
    const element = only('<input type="checkbox">');
    expect(classifyStructural(element, context({ skipPreFilled: true })).fillable).toBe(true);
  });

  it('does not treat its own earlier write as user content', () => {
    // BR-005-7: without this, "skip fields that already have content" would
    // silently disable filling the same page twice — two reasonable settings
    // cancelling each other out.
    const element = only('<input value="written by us">');
    const writtenByUs = new WeakSet<Element>([element]);
    expect(
      classifyStructural(element, { skipHidden: false, skipPreFilled: true, writtenByUs }).fillable,
    ).toBe(true);
  });

  it('excludes a radio whose group is already answered', () => {
    // A1: the group is answered, not the individual button.
    const root = fragment('<form><input type="radio" name="g" value="a" checked><input type="radio" name="g" value="b"></form>');
    const unchecked = root.querySelector<HTMLInputElement>('input[value="b"]')!;
    expect(classifyStructural(unchecked, context({ skipPreFilled: true }))).toEqual({
      fillable: false,
      reason: 'pre-filled',
    });
  });
});

describe('confirmation fields (UC-006, ND-7, D2)', () => {
  const valueFor = (html: string): string => {
    const value = generateValue(descriptorFor(html), persona, random);
    return value.as === 'text' ? value.value : '';
  };

  it('gives a confirm field the same value as the field it confirms', () => {
    // Both read the same record slot, so they agree by construction rather than
    // by replaying a previously generated value.
    expect(valueFor('<input type="email" name="email">')).toBe(
      valueFor('<input type="email" name="confirm_email">'),
    );
  });

  it('mirrors a confirm field identified only by its label', () => {
    // D2: the reference tests `element.name` alone, so a "Confirm password"
    // field identified by its label never mirrors — even though matching for
    // everything else uses all sources.
    expect(valueFor('<input type="password" name="pw1">')).toBe(
      valueFor('<label>Confirm password<input type="password" name="pw2"></label>'),
    );
  });

  it('agrees regardless of which field appears first', () => {
    // ND-7: the reference replays the last generated value, so a confirm field
    // appearing *before* its source mirrors whatever came earlier — often lorem
    // ipsum.
    const confirmFirst = valueFor('<input name="confirm_email" type="email">');
    const sourceSecond = valueFor('<input name="email" type="email">');
    expect(confirmFirst).toBe(sourceSecond);
  });

  it('is not disturbed by unrelated fields in between', () => {
    // ND-7: `previousValue` is shared by text and email fields, so any text
    // input between the two clobbers what gets mirrored.
    const first = valueFor('<input type="email" name="email">');
    valueFor('<input type="text" name="nickname">');
    valueFor('<input type="text" name="street">');
    expect(valueFor('<input type="email" name="email_confirmation">')).toBe(first);
  });
});

describe('applying each kind', () => {
  const apply = (element: Element, value: FieldValue) =>
    applyValue(element, value, { dispatchEvents: true });

  it('clicks a checkbox rather than only setting it', () => {
    // ND-6: a click is honest here — it is the interaction the control actually
    // receives — where a click on a text input is a lie the page may act on.
    const box = only('<input type="checkbox">') as HTMLInputElement;
    const seen: string[] = [];
    for (const type of ['click', 'change']) box.addEventListener(type, () => seen.push(type));

    apply(box, { ref: 0, as: 'toggle', checked: true, provenance: 'test' });

    expect(box.checked).toBe(true);
    expect(seen).toEqual(['click', 'change']);
  });

  it('dispatches nothing when the control is already in the requested state', () => {
    // Telling the page about a change that did not happen is its own defect.
    const box = only('<input type="checkbox" checked>') as HTMLInputElement;
    const seen: string[] = [];
    box.addEventListener('change', () => seen.push('change'));

    apply(box, { ref: 0, as: 'toggle', checked: true, provenance: 'test' });

    expect(seen).toEqual([]);
  });

  it('selects options on a multi-select and fires change once', () => {
    const select = only('<select multiple><option value="a">A</option><option value="b">B</option></select>') as HTMLSelectElement;
    const seen: string[] = [];
    select.addEventListener('change', () => seen.push('change'));

    apply(select, { ref: 0, as: 'choice', values: ['a', 'b'], provenance: 'test' });

    expect([...select.selectedOptions].map((option) => option.value)).toEqual(['a', 'b']);
    expect(seen).toEqual(['change']);
  });

  it('ticks only the radio whose value was chosen', () => {
    const root = fragment('<form><input type="radio" name="g" value="a"><input type="radio" name="g" value="b"></form>');
    const [a, b] = [...root.querySelectorAll<HTMLInputElement>('input')];

    apply(a!, { ref: 0, as: 'choice', values: ['b'], provenance: 'test' });
    apply(b!, { ref: 1, as: 'choice', values: ['b'], provenance: 'test' });

    expect(a!.checked).toBe(false);
    expect(b!.checked).toBe(true);
  });

  it('leaves a control untouched when the value says to skip it', () => {
    const select = only('<select><option value="a" disabled>A</option></select>') as HTMLSelectElement;
    apply(select, { ref: 0, as: 'skip', reason: 'no-selectable-option', provenance: 'test' });
    expect(select.selectedIndex).toBe(-1);
  });
});

describe('kind coverage', () => {
  it('produces a usable value for every kind the engine claims to support', () => {
    // The union is closed so that adding a kind is a compile error where it must
    // be handled; this is the runtime half of that guarantee.
    const kinds: ControlKind[] = [
      'text', 'email', 'tel', 'url', 'search', 'password', 'textarea',
      'number', 'range', 'date', 'datetime-local', 'month', 'week', 'time', 'color',
      'checkbox', 'radio', 'select-one', 'select-multiple', 'contenteditable',
    ];

    for (const kind of kinds) {
      const needsOptions = kind === 'radio' || kind === 'select-one' || kind === 'select-multiple';
      const value = generateValue(
        {
          ref: 0,
          kind,
          sources: {},
          constraints: {},
          ...(needsOptions ? { options: [{ value: 'a', label: 'A', disabled: false }] } : {}),
        },
        persona,
        random,
      );
      expect(value.provenance, `${kind} must explain itself`).not.toBe('');
      if (value.as === 'text') expect(value.value, `${kind} must not be empty`).not.toBe('');
    }
  });
});
