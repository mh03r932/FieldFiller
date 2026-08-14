import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classifyStructural } from '@/lib/page/exclude';
import type { FieldValue } from '@/lib/protocol';

/** Defaults for the structural checks: honeypots skipped, pre-filled allowed. */
const CONTEXT = {
  skipHidden: false,
  skipPreFilled: false,
  writtenByUs: new WeakSet<Element>(),
};

const classify = (element: Element) => classifyStructural(element, CONTEXT);

/** A text value, as the generator would produce it. */
const textValue = (value: string): FieldValue => ({ ref: 0, as: 'text', value, provenance: 'test' });
import { describe as describeField } from '@/lib/page/identify';
import { applyValue, verifyWrite } from '@/lib/page/apply';

/**
 * The page-side engine, tested without a browser extension host.
 *
 * That this is possible at all is NFR-015 doing its job: the engine takes a DOM
 * root and returns descriptors, or takes a value and applies it. The reference
 * cannot be tested this way because `ElementFiller` reaches into the global
 * `document` for radio groups and label lookups (ND-5).
 */

function fragment(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('walk', () => {
  it('collects candidates from the given root, not the document', () => {
    // ND-5. A `document`-scoped query would find both, which is precisely why
    // "fill this form" is not actually scoped to the form in the reference.
    fragment('<input name="outside">');
    const root = fragment('<form><input name="inside"><textarea></textarea></form>');

    const found = collectCandidates(root).map((element) => element.tagName);
    expect(found).toEqual(['INPUT', 'TEXTAREA']);
  });

  it('returns candidates in document order', () => {
    const root = fragment('<input name="a"><input name="b"><input name="c">');
    const names = collectCandidates(root).map((element) => element.getAttribute('name'));
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('descends into an open shadow root', () => {
    // FR-008. `querySelectorAll` does not cross a shadow boundary, which is why
    // Lit, Stencil and Ionic design systems are entirely invisible to the
    // reference (§7.3).
    const root = fragment('<div id="host"></div><input name="light">');
    const host = root.querySelector('#host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<input name="shadow">';

    const names = collectCandidates(root).map((element) => element.getAttribute('name'));
    expect(names).toContain('light');
    expect(names).toContain('shadow');
  });

  it('descends into nested shadow roots', () => {
    const root = fragment('<div id="outer"></div>');
    const outer = root.querySelector('#outer')!.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id="inner"></div>';
    outer.querySelector('#inner')!.attachShadow({ mode: 'open' }).innerHTML = '<input name="deep">';

    expect(collectCandidates(root).map((element) => element.getAttribute('name'))).toEqual(['deep']);
  });

  it('cannot see into a closed shadow root, and does not pretend to', () => {
    // C-006: unreachable by any extension API, permanently. Documented honestly
    // rather than worked around.
    const root = fragment('<div id="host"></div>');
    root.querySelector('#host')!.attachShadow({ mode: 'closed' }).innerHTML = '<input name="hidden">';

    expect(collectCandidates(root)).toEqual([]);
  });
});

describe('exclude', () => {
  const only = (html: string) => collectCandidates(fragment(html))[0]!;

  it.each([
    ['disabled', '<input disabled>', 'disabled'],
    ['read-only', '<input readonly>', 'readonly'],
    ['aria-disabled', '<input aria-disabled="true">', 'aria-disabled'],
    ['submit', '<input type="submit">', 'not-fillable-kind'],
    ['button', '<input type="button">', 'not-fillable-kind'],
    ['reset', '<input type="reset">', 'not-fillable-kind'],
    ['file', '<input type="file">', 'not-fillable-kind'],
    ['image', '<input type="image">', 'not-fillable-kind'],
    ['hidden', '<input type="hidden">', 'not-fillable-kind'],
  ])('excludes a %s control', (_label, html, reason) => {
    expect(classify(only(html))).toEqual({ fillable: false, reason });
  });

  it('reports availability before kind', () => {
    // BR-005-6: one reason per exclusion, and it must be the useful one.
    // "not a fillable kind" for a disabled text input sends someone looking in
    // entirely the wrong place.
    expect(classify(only('<input type="text" disabled>'))).toEqual({
      fillable: false,
      reason: 'disabled',
    });
  });

  it.each([
    ['<input type="text">', 'text'],
    ['<input type="email">', 'email'],
    ['<input type="tel">', 'tel'],
    ['<input type="url">', 'url'],
    ['<input type="search">', 'search'],
    ['<input type="password">', 'password'],
    ['<input>', 'text'],
    ['<textarea></textarea>', 'textarea'],
  ])('accepts %s', (html, kind) => {
    expect(classify(only(html))).toEqual({ fillable: true, kind });
  });

  it('excludes rather than throws when classification fails', () => {
    // BR-005-1: exclusion is fail-safe. Filling a field that should have been
    // left alone is destructive and silent; skipping one is visible and
    // recoverable.
    const hostile = { get tagName(): string { throw new Error('hostile'); } } as unknown as Element;
    expect(classify(hostile)).toEqual({ fillable: false, reason: 'unclassifiable' });
  });
});

describe('identify', () => {
  const describeOnly = (html: string) => {
    const element = collectCandidates(fragment(html))[0]!;
    return describeField(element, 0, 'text');
  };

  it('reads an implicit label that wraps the control', () => {
    // ND-3 / FR-066. `label[for=…]` cannot see this form at all, so a field whose
    // only human-readable identity is a wrapping label gets lorem ipsum.
    expect(describeOnly('<label>Email address<input></label>').sources.label).toBe('Email address');
  });

  it('reads an explicit label referencing the control by id', () => {
    expect(describeOnly('<label for="x">Given name</label><input id="x">').sources.label).toBe(
      'Given name',
    );
  });

  it('reads label text, never label markup', () => {
    // D1: read as innerHTML and stripped of non-alphanumerics, this label
    // matches as "spanemailspan", so a rule containing /span/ fires on every
    // wrapped label in the page.
    const label = describeOnly('<label><span>Email</span><input></label>').sources.label;
    expect(label).toBe('Email');
    expect(label).not.toContain('span');
  });

  it('keeps matching sources separate rather than concatenating them', () => {
    // ND-2. Flattened into one blob, `^name$` can never match and a Bootstrap
    // class makes an unrelated field match /date/.
    const sources = describeOnly(
      '<label>Full name<input name="user_name" id="fullName" placeholder="Jane Doe" aria-label="Name"></label>',
    ).sources;
    expect(sources).toEqual({
      name: 'user_name',
      id: 'fullName',
      label: 'Full name',
      placeholder: 'Jane Doe',
      ariaLabel: 'Name',
    });
  });

  it('takes the purpose from the last autocomplete token', () => {
    expect(describeOnly('<input autocomplete="shipping given-name">').autocomplete).toBe('given-name');
  });

  it('ignores autocomplete="off", which states no purpose', () => {
    expect(describeOnly('<input autocomplete="off">').autocomplete).toBeUndefined();
  });

  it('omits constraints the control does not declare', () => {
    // maxLength reads -1 when unset, which is not a constraint of any kind.
    expect(describeOnly('<input>').constraints).toEqual({});
    expect(describeOnly('<input maxlength="5">').constraints).toEqual({ maxLength: 5 });
  });

  it('never carries the existing value of the control', () => {
    // BR-004-10 / NFR-030: a descriptor says what a control *is*, never what it
    // holds. Not collecting it is what makes the privacy claim structural.
    const descriptor = describeOnly('<input name="x" value="secret@example.com">');
    expect(JSON.stringify(descriptor)).not.toContain('secret');
  });
});

describe('apply', () => {
  it('writes through the prototype setter, bypassing an instance value tracker', () => {
    // This is the whole framework-safe-write technique, so it is asserted
    // against the thing it exists to defeat rather than against a spy.
    //
    // React installs its value tracker as an *own* property on the element,
    // shadowing the prototype's accessor. A plain `element.value = x` therefore
    // goes through the tracker, which records the new value as one React itself
    // set — so React sees no change and reverts on the next render. Calling the
    // prototype's setter with the element as receiver skips the own property
    // entirely, which is why the value sticks.
    const input = collectCandidates(fragment('<input>'))[0] as HTMLInputElement;
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let trackerWrites = 0;

    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native.get!.call(input) as string,
      set: (value: string) => {
        trackerWrites++;
        native.set!.call(input, value);
      },
    });

    applyValue(input, textValue('written'), { dispatchEvents: false });

    expect(input.value).toBe('written');
    expect(trackerWrites).toBe(0);
  });

  it('dispatches focus, input, change and blur — and never click', () => {
    // ND-6. A synthetic click on a text input opens date pickers and trips
    // submit handlers; it is a lie the page may act on.
    const input = collectCandidates(fragment('<input>'))[0] as HTMLInputElement;
    const seen: string[] = [];
    for (const type of ['focus', 'input', 'change', 'blur', 'click']) {
      input.addEventListener(type, () => seen.push(type));
    }

    applyValue(input, textValue('value'), { dispatchEvents: true });

    expect(seen).toEqual(['focus', 'input', 'change', 'blur']);
  });

  it('fires input as an InputEvent and change as non-cancelable', () => {
    const input = collectCandidates(fragment('<input>'))[0] as HTMLInputElement;
    let inputEvent: Event | undefined;
    let changeEvent: Event | undefined;
    input.addEventListener('input', (event) => (inputEvent = event));
    input.addEventListener('change', (event) => (changeEvent = event));

    applyValue(input, textValue('value'), { dispatchEvents: true });

    expect(inputEvent).toBeInstanceOf(InputEvent);
    expect(inputEvent?.bubbles).toBe(true);
    // The reference constructs `change` as cancelable, which it is not — that
    // tells a listener it can preventDefault something it cannot.
    expect(changeEvent?.cancelable).toBe(false);
  });

  it('writes without any events when the user has turned them off', () => {
    // UC-004 A8.
    const input = collectCandidates(fragment('<input>'))[0] as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));

    applyValue(input, textValue('quiet'), { dispatchEvents: false });

    expect(input.value).toBe('quiet');
    expect(seen).toEqual([]);
  });

  it('fills a textarea through its own prototype setter', () => {
    const area = collectCandidates(fragment('<textarea></textarea>'))[0] as HTMLTextAreaElement;
    applyValue(area, textValue('paragraph'), { dispatchEvents: true });
    expect(area.value).toBe('paragraph');
  });

  it('fills a content-editable region and fires input on it', () => {
    // D8: the reference writes to contenteditable without any events at all, so
    // React, Quill and ProseMirror never observe the change — and it skips the
    // exclusion checks too, overwriting rich-text editors even with "ignore
    // fields with content" enabled.
    const div = fragment('<div contenteditable="true"></div>').firstElementChild as HTMLElement;
    const seen: string[] = [];
    for (const type of ['input', 'click']) div.addEventListener(type, () => seen.push(type));

    applyValue(div, textValue('written'), { dispatchEvents: true });

    expect(div.textContent).toBe('written');
    expect(seen).toEqual(['input']);
  });

  it('throws for an element that can hold no value at all', () => {
    const span = fragment('<span></span>').firstElementChild!;
    // The caller isolates this per field, so one impossible control cannot end
    // the run (BR-004-11).
    expect(() => applyValue(span, textValue('x'), { dispatchEvents: false })).toThrow();
  });
});

/**
 * FR-076. The half of UC-034 that needs no loop: having written is not the same
 * as having been written to.
 *
 * The cases below split into two halves that pull in opposite directions, which
 * is the whole difficulty. A page that *rejected* our value must be reported as
 * a failure; a page that merely *reformatted* it must not. Verification that
 * gets the first half right by comparing strings gets the second half
 * catastrophically wrong, reporting a correctly filled page as a wall of
 * failures (BR-034-4).
 */
describe('verify', () => {
  const choiceValue = (...values: string[]): FieldValue => ({
    ref: 0, as: 'choice', values, provenance: 'test',
  });
  const toggleValue = (checked: boolean): FieldValue => ({
    ref: 0, as: 'toggle', checked, provenance: 'test',
  });

  const write = (element: Element, value: FieldValue) => {
    applyValue(element, value, { dispatchEvents: true });
    return verifyWrite(element, value);
  };

  /** `new Option(…)` is not a happy-dom global; the long form is. */
  const option = (value: string, label: string): HTMLOptionElement => {
    const element = document.createElement('option');
    element.value = value;
    element.textContent = label;
    return element;
  };

  it('accepts a value the page reformatted', () => {
    // A reference field that uppercases itself, a currency mask, a phone mask:
    // the page rewrote what we sent and *kept* it. That is a successful fill.
    const input = fragment('<input>').firstElementChild as HTMLInputElement;
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });

    expect(write(input, textValue('booking-ref')).landed).toBe(true);
    expect(input.value).toBe('BOOKING-REF');
  });

  it('accepts a value the control normalised on its own', () => {
    // `007` in a number field reads back as `7`. Nothing rejected it.
    const input = fragment('<input type="number" min="1" max="99">').firstElementChild as HTMLInputElement;
    expect(write(input, textValue('007')).landed).toBe(true);
  });

  it('accepts a value that satisfies the control\'s own constraints', () => {
    const input = fragment('<input maxlength="8" minlength="2">').firstElementChild as HTMLInputElement;
    expect(write(input, textValue('fits')).landed).toBe(true);
  });

  // Not tested here: a value longer than `maxlength`. The platform reports
  // `tooLong` only for a value the *user* dirtied, so a browser calls an
  // over-long programmatic write valid — while happy-dom sets the flag anyway.
  // A test either way would assert the test environment rather than the engine.
  // The generator honours the constraint before we get here (D4, BR-004-7), and
  // `e2e-chrome.mjs` asserts that against a real browser.

  it('reports a value the page cleared', () => {
    // The reset-loop page: a handler that empties the field on every input.
    // Before FR-076 this counted as filled and the badge said so.
    const input = fragment('<input>').firstElementChild as HTMLInputElement;
    input.addEventListener('input', () => { input.value = ''; });

    const result = write(input, textValue('coupon'));
    expect(result).toEqual({ landed: false, reason: 'value-did-not-take' });
  });

  it('reports a value the control cannot hold', () => {
    const input = fragment('<input type="number" min="1" max="10">').firstElementChild as HTMLInputElement;
    const result = write(input, textValue('500'));
    expect(result).toEqual({ landed: false, reason: 'invalid-for-control' });
  });

  it('reports a selection whose options were rewritten underneath it', () => {
    // UC-034 A1, the case DD-009 exists for: the option chosen from the
    // descriptor no longer exists by the time it is applied. The select falls
    // back to its placeholder, and without this it is reported as filled.
    const select = fragment(
      '<select><option value="">Choose…</option><option value="dev">Devon</option></select>',
    ).firstElementChild as HTMLSelectElement;

    select.addEventListener('change', () => {
      select.replaceChildren(option('', 'Choose…'), option('ut', 'Utrecht'));
    });

    const result = write(select, choiceValue('dev'));
    expect(result).toEqual({ landed: false, reason: 'options-changed' });
  });

  it('accepts a selection that took', () => {
    const select = fragment(
      '<select><option value="">Choose…</option><option value="dev">Devon</option></select>',
    ).firstElementChild as HTMLSelectElement;
    expect(write(select, choiceValue('dev')).landed).toBe(true);
  });

  it('reports a multi-select that took only some of its options', () => {
    // Counted as sets, not by length: two of the three asked for is not the
    // instruction, and the difference is visible to the user submitting it.
    const select = fragment(
      '<select multiple><option value="a">A</option><option value="b">B</option></select>',
    ).firstElementChild as HTMLSelectElement;

    select.addEventListener('change', () => {
      for (const option of select.options) option.selected = option.value === 'a';
    });

    const result = write(select, choiceValue('a', 'b'));
    expect(result).toEqual({ landed: false, reason: 'selection-did-not-take' });
  });

  it('accepts a checkbox in the state it was set to', () => {
    const box = fragment('<input type="checkbox">').firstElementChild as HTMLInputElement;
    expect(write(box, toggleValue(true)).landed).toBe(true);
  });

  it('reports a checkbox whose page refused the click', () => {
    // A page calling `preventDefault` on the click keeps its checkbox unchanged
    // — correct behaviour on its part, and a fill that did not happen on ours.
    const box = fragment('<input type="checkbox">').firstElementChild as HTMLInputElement;
    box.addEventListener('click', (event) => event.preventDefault());

    const result = write(box, toggleValue(true));
    expect(result).toEqual({ landed: false, reason: 'toggle-did-not-change' });
  });

  it('reports an emptied content-editable region', () => {
    const div = fragment('<div contenteditable="true"></div>').firstElementChild as HTMLElement;
    div.addEventListener('input', () => { div.textContent = ''; });

    const result = write(div, textValue('written'));
    expect(result).toEqual({ landed: false, reason: 'value-did-not-take' });
  });

  it('has nothing to verify for a control the generator skipped', () => {
    const input = fragment('<input>').firstElementChild as HTMLInputElement;
    const skip: FieldValue = { ref: 0, as: 'skip', reason: 'no-selectable-option', provenance: 'test' };
    expect(verifyWrite(input, skip).landed).toBe(true);
  });
});
