import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classify, classifyStructural, matchesIgnorePattern, radioGroup } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { applyValue, type WritableValue } from '@/lib/page/apply';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { generateValue, mirrorsAnotherField } from '@/lib/generators/default-generator';
import { generateBatch } from '@/lib/generators/batch';
import type { ControlKind, FieldDescriptor } from '@/lib/protocol';

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
    ).values;
    for (const [index, entry] of fillable.entries()) {
      const value = values[index]!;
      // Narrowed rather than cast: `pick` is driven, not written, and a radio
      // group producing one would be a routing bug worth failing on.
      if (value.as === 'pick') throw new Error('a radio group is never a combobox');
      applyValue(entry.radio, value, { dispatchEvents: true });
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

/**
 * Gives an element a real geometry.
 *
 * The test DOM lays nothing out: every element reports a zero-sized rect, and
 * `isPerceivable` rejects a zero-sized control before it reaches any of the
 * checks below. So without this every one of these cases passed for the same
 * wrong reason — the control was not *hidden*, it was unmeasured — and a build
 * that had deleted the honeypot logic entirely would have passed them all.
 *
 * Stubbed per element rather than globally, so the off-screen case can still
 * report the coordinates that make it off-screen.
 */
function laidOut(element: Element, box: Partial<DOMRect> = {}): Element {
  const rect = { x: 0, y: 0, top: 0, left: 0, width: 120, height: 24, ...box };
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    configurable: true,
  });
  return element;
}

describe('hidden and honeypot exclusion (UC-005 A3, ND-16)', () => {
  const hidden = (element: Element) => classifyStructural(element, context({ skipHidden: true }));

  beforeEach(() => {
    // The document's own extent is layout too, and the test DOM reports zero for
    // it — which would put every control below the first pixel "outside the
    // document". A page tall enough to scroll is the ordinary case, so that is
    // what these tests describe.
    for (const [property, value] of [['scrollWidth', 1200], ['scrollHeight', 8000]] as const) {
      Object.defineProperty(document.documentElement, property, { value, configurable: true });
    }
  });

  it('fills an ordinary visible control', () => {
    // The control case, and the one that was missing. Every assertion below is
    // only meaningful if this one holds: they claim a *reason* for exclusion,
    // which means nothing unless a control without that reason survives.
    expect(hidden(laidOut(only('<input>'))).fillable).toBe(true);
  });

  it.each([
    ['display:none', 'display:none', {}],
    ['visibility:hidden', 'visibility:hidden', {}],
    ['zero opacity', 'opacity:0', {}],
    ['clip-path', 'clip-path:inset(100%)', {}],
    ['the legacy clip rectangle', 'clip:rect(0px, 0px, 0px, 0px)', {}],
    ['zero size', '', { width: 0, height: 0 }],
    ['being positioned off the left of the document', '', { left: -9999, width: 100 }],
    ['being positioned above the document', '', { top: -9999, height: 100 }],
  ])('excludes a control hidden by %s', (_label, style, box) => {
    const element = laidOut(only(`<input style="${style}">`), box);
    expect(hidden(element)).toEqual({ fillable: false, reason: 'hidden' });
  });

  it('excludes a control hidden from assistive technology and the tab order', () => {
    // Either alone is too weak: `aria-hidden` appears on decorative wrappers and
    // `tabindex="-1"` on controls a script focuses. Together they are a honeypot.
    const element = laidOut(only('<input aria-hidden="true" tabindex="-1">'));
    expect(hidden(element)).toEqual({ fillable: false, reason: 'hidden' });
  });

  it('fills a control that is only removed from the tab order', () => {
    expect(hidden(laidOut(only('<input tabindex="-1">'))).fillable).toBe(true);
  });

  it('fills a control merely below the fold, which the user can scroll to', () => {
    expect(hidden(laidOut(only('<input>'), { top: 4000 })).fillable).toBe(true);
  });

  it('fills a hidden control when the user has turned the check off', () => {
    const element = laidOut(only('<input style="display:none">'));
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

/**
 * The second address line, reached by name rather than by `autocomplete`.
 *
 * The slot arrived with the corpus and was reachable only through
 * `autocomplete="address-line2"`: `/address|street/` sat above it in the hint
 * list and first match wins, so every `address2` went to the *first* line. That
 * is not merely the wrong slot — `2$` is also a confirmation marker, so the
 * field was told to agree with the street address and both lines came out
 * identical.
 */
describe('second address line by identity (UC-004)', () => {
  const valueFor = (html: string): string => {
    const value = generateValue(descriptorFor(html), persona, random);
    return value.as === 'text' ? value.value : '';
  };

  it.each([
    ['a bare ordinal', '<input name="address2">'],
    ['an underscored line number', '<input name="address_line_2">'],
    ['a hyphenated line number', '<input name="address-line-2">'],
    ['a human label', '<label>Address line 2<input name="al2"></label>'],
    ['the German storey', '<input name="stock">'],
    ['an apartment', '<input name="apartment">'],
  ])('resolves %s to the second line', (_label, html) => {
    expect(valueFor(html)).toBe(persona.addressLine2);
  });

  it.each([
    ['address', '<input name="address">'],
    ['street', '<input name="street">'],
    ['address_line_1', '<input name="address_line_1">'],
  ])('still resolves %s to the first line', (_label, html) => {
    expect(valueFor(html)).toBe(persona.streetAddress);
  });

  it('does not give the two lines the same value', () => {
    // The failure this whole block exists for: one persona, two lines, and a
    // form that reads as though the user typed their street twice.
    expect(valueFor('<input name="address">')).not.toBe(valueFor('<input name="address2">'));
  });

  it('does not let a city keep its slot be stolen by a placeholder', () => {
    // `identityOf` joins every source, so a city field suggesting "Stockholm"
    // carries the letters `stock`. The storey token is therefore anchored: it
    // has to be the word, not a fragment of a place name. Guards the reordering
    // above, which is what made this reachable at all.
    expect(valueFor('<input name="city" placeholder="e.g. Stockholm">')).toBe(persona.locality);
  });

  it('is not a confirmation field, so a rule on it is not overridden', () => {
    // `2$` marks a field as confirming another (UC-006), which is right for
    // `password2` and wrong here: the 2 is an ordinal, not a repetition. Left
    // as-is, a user rule aimed at `address2` loses to a mirror of a field it
    // never confirmed (DD-005).
    expect(mirrorsAnotherField(descriptorFor('<input name="address2">'))).toBe(false);
    expect(mirrorsAnotherField(descriptorFor('<input name="password2">'))).toBe(true);
  });
});

describe('applying each kind', () => {
  const apply = (element: Element, value: WritableValue) =>
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

describe('identity sources (FR-027, ND-2)', () => {
  it('collects every source separately, class included', () => {
    const element = only(
      '<input name="n" id="i" class="Field__input" placeholder="p" aria-label="a">',
    );
    // Separately, never concatenated. A blob cannot be anchored, cannot say
    // which source matched, and lets a class trigger a rule meant for a name.
    expect(describeField(element, 0, 'text').sources).toEqual({
      name: 'n',
      id: 'i',
      className: 'Field__input',
      label: undefined,
      placeholder: 'p',
      ariaLabel: 'a',
    });
  });

  it('reads a label the control points at with aria-labelledby', () => {
    // `element.labels` is empty for anything not form-associated, so a custom
    // combobox arrives at matching carrying nothing but an id without this.
    const root = fragment('<span id="lbl">Currency</span><div id="c" role="combobox" aria-labelledby="lbl"></div>');
    const combobox = root.querySelector('#c')!;
    expect(describeField(combobox, 0, 'combobox').sources.label).toBe('Currency');
  });

  it('joins several labelling elements in the order the page listed them', () => {
    const root = fragment('<span id="a">Billing</span><span id="b">Country</span><div id="c" role="combobox" aria-labelledby="a b"></div>');
    expect(describeField(root.querySelector('#c')!, 0, 'combobox').sources.label).toBe('Billing Country');
  });

  it('prefers a real label over aria-labelledby where both exist', () => {
    const root = fragment('<span id="lbl">Pointed at</span><label for="f">Real</label><input id="f" aria-labelledby="lbl">');
    expect(describeField(root.querySelector('#f')!, 0, 'text').sources.label).toBe('Real');
  });

  it('omits a source the control does not carry rather than storing it empty', () => {
    expect(describeField(only('<input name="n">'), 0, 'text').sources).toEqual({ name: 'n' });
  });
});

describe('custom combobox detection (FR-081)', () => {
  it.each([
    ['a div declaring itself a combobox', '<div role="combobox"></div>'],
    ['a div declaring itself a listbox', '<div role="listbox"></div>'],
    ['a button that opens a listbox', '<button aria-haspopup="listbox"></button>'],
  ])('recognises %s', (_label, html) => {
    expect(classifyStructural(only(html), context())).toEqual({ fillable: true, kind: 'combobox' });
  });

  it('treats an input wearing the role as the text input it is', () => {
    // The ARIA autocomplete pattern: a text input with a popup attached. Typing
    // into it is right, and driving it through the ladder would replace a
    // working fill with an interaction that has to be verified.
    expect(classifyStructural(only('<input role="combobox">'), context())).toEqual({
      fillable: true,
      kind: 'text',
    });
  });

  it('cannot tell whether a custom combobox already holds an answer, so leaves it alone', () => {
    // BR-005-1 decides the direction. A `<div>` exposes rendered text, in which
    // a chosen answer and a placeholder are the same shape — so with the toggle
    // on we say we do not know rather than claiming we looked.
    expect(classifyStructural(only('<div role="combobox">Select…</div>'), context({ skipPreFilled: true }))).toEqual({
      fillable: false,
      reason: 'content-unknown',
    });
  });
});

describe('ignore patterns (UC-005 step 5, BR-005-6)', () => {
  const withPatterns = (patterns: RegExp[], overrides = {}) => ({
    ...context(overrides),
    ignorePatterns: patterns,
    identity: [] as string[],
  });

  it('excludes a control whose identity matches', () => {
    const element = only('<input name="captcha_answer">');
    const ctx = { ...withPatterns([/captcha/i]), identity: ['captcha_answer'] };
    expect(classify(element, ctx)).toEqual({ fillable: false, reason: 'ignored-pattern' });
  });

  it('reports the pattern as the reason even when the control is also hidden', () => {
    // The first rule to fire in UC-005's order is the reason reported, and step
    // 5 sits before step 6. A user debugging a skipped field needs one answer.
    const element = only('<input name="captcha" style="display:none">');
    const ctx = { ...withPatterns([/captcha/i], { skipHidden: true }), identity: ['captcha'] };
    expect(classify(element, ctx)).toEqual({ fillable: false, reason: 'ignored-pattern' });
  });

  it('still reports a structural exclusion ahead of the pattern', () => {
    // A disabled control was never fillable; saying it was "ignored" would send
    // someone looking for a pattern that is not the cause.
    const element = only('<input name="captcha" disabled>');
    const ctx = { ...withPatterns([/captcha/i]), identity: ['captcha'] };
    expect(classify(element, ctx)).toEqual({ fillable: false, reason: 'disabled' });
  });

  it('does not let a global pattern carry state between fields', () => {
    // A `/g` pattern keeps `lastIndex` between calls, so it matches every other
    // field. Reset per test, which this asserts by testing the same source twice.
    const sticky = /token/g;
    expect(matchesIgnorePattern(['csrf_token'], [sticky])).toBe(true);
    expect(matchesIgnorePattern(['csrf_token'], [sticky])).toBe(true);
  });

  it('matches each source on its own so a pattern can be anchored', () => {
    // Anchoring is the property a flattened blob destroys (ND-2): `^name$` can
    // only mean anything if it is tested against one source at a time.
    expect(matchesIgnorePattern(['name', 'a-long-label'], [/^name$/])).toBe(true);
    expect(matchesIgnorePattern(['username', 'a-long-label'], [/^name$/])).toBe(false);
  });
});

describe('pre-filled exclusion, per control kind (UC-005 step 7)', () => {
  const filled = (html: string) => classifyStructural(only(html), context({ skipPreFilled: true }));

  it('treats a chosen option as content', () => {
    expect(filled('<select><option value="">Choose…</option><option value="a" selected>A</option></select>')).toEqual({
      fillable: false,
      reason: 'pre-filled',
    });
  });

  it('does not treat a placeholder option as content', () => {
    // A select resting on its empty placeholder has not been answered.
    expect(filled('<select><option value="" selected>Choose…</option><option value="a">A</option></select>').fillable).toBe(true);
  });

  it('treats text in a content-editable region as content', () => {
    expect(filled('<div contenteditable="true">a draft</div>')).toEqual({
      fillable: false,
      reason: 'pre-filled',
    });
  });

  it('does not treat whitespace in a content-editable region as content', () => {
    expect(filled('<div contenteditable="true">   </div>').fillable).toBe(true);
  });
});

describe('generated credentials never leak (D5, FR-026)', () => {
  it('writes nothing to the console while generating a password', () => {
    // The reference writes the generated password to the page console via
    // `console.info`, which puts credentials into the page's log and into any
    // console-capturing tooling watching it.
    const seen: unknown[][] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    // Bound as it is captured: referencing `console.log` as a value detaches it
    // from `console`, and restoring the detached form later would be a subtler
    // change than this test is trying to make.
    const originals = methods.map((name) => [name, console[name].bind(console)] as const);
    for (const name of methods) console[name] = (...args: unknown[]) => void seen.push(args);

    try {
      for (let seed = 0; seed < 25; seed++) {
        generateValue(descriptorFor('<input type="password">'), persona, seededRandom(seed));
      }
    } finally {
      for (const [name, fn] of originals) console[name] = fn;
    }

    expect(seen).toEqual([]);
  });
});

describe('passwords honour what the field itself demands (FR-072, D9)', () => {
  const passwordFor = (attributes: string) =>
    generateValue(descriptorFor(`<input type="password" ${attributes}>`), persona, seededRandom(3));

  const text = (value: ReturnType<typeof passwordFor>) => (value.as === 'text' ? value.value : '');

  it('keeps one of each character class when squeezed by maxlength', () => {
    // Plain slicing takes the tail off, where the digit and symbol sit — leaving
    // a value that is short enough and fails the policy it was built for.
    const value = text(passwordFor('maxlength="10"'));
    expect(value).toHaveLength(10);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[0-9]/);
  });

  it('reaches a minimum length the field demands', () => {
    expect(text(passwordFor('minlength="40"')).length).toBeGreaterThanOrEqual(40);
  });

  it('drops the symbol for a field whose pattern forbids one', () => {
    // The commonest real pattern by a distance, and the one thing our default
    // password fails on. Satisfying an arbitrary regex is not solvable; this one
    // shape is, and it is most of the population.
    const value = text(passwordFor('pattern="[A-Za-z0-9]{8,}"'));
    expect(value).toMatch(/^[A-Za-z0-9]{8,}$/);
  });

  it('uses a symbol the pattern does allow', () => {
    const value = text(passwordFor('pattern="[A-Za-z0-9!]{8,}"'));
    expect(value).toMatch(/^[A-Za-z0-9!]{8,}$/);
    expect(value).toMatch(/!/);
  });

  it('honours a pattern and a length ceiling together', () => {
    const value = text(passwordFor('pattern="[A-Za-z0-9]{6,}" maxlength="12"'));
    expect(value).toMatch(/^[A-Za-z0-9]{6,12}$/);
  });

  it('keeps its value when no rung of the ladder fits', () => {
    // An unsatisfiable pattern is not a reason to write nothing: the value is
    // kept, and write-verification reports the control as failed rather than the
    // fill claiming a value the page will reject (FR-076).
    const value = text(passwordFor('pattern="[0-9]{4}"'));
    expect(value).not.toBe('');
  });

  it('treats a pattern it cannot parse as satisfied', () => {
    // We cannot judge against a rule we cannot read, and the browser will not
    // enforce it either. Same call UC-005 A5 makes for an invalid ignore pattern.
    expect(text(passwordFor('pattern="([unclosed"'))).not.toBe('');
  });

  it('anchors the pattern, as the platform does', () => {
    // `pattern="\\d{4}"` means the whole value is four digits, not that four
    // digits appear somewhere in it. An unanchored test would accept our default
    // password unchanged and call the field satisfied.
    const value = text(passwordFor('pattern="[A-Za-z0-9]{8,}"'));
    expect(/[^A-Za-z0-9]/.test(value)).toBe(false);
  });
});
