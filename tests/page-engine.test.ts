import { beforeEach, describe, expect, it } from 'vitest';
import { collectCandidates } from '@/lib/page/walk';
import { classify } from '@/lib/page/exclude';
import { describe as describeField } from '@/lib/page/identify';
import { applyValue } from '@/lib/page/apply';

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

    applyValue(input, 'written', { dispatchEvents: false });

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

    applyValue(input, 'value', { dispatchEvents: true });

    expect(seen).toEqual(['focus', 'input', 'change', 'blur']);
  });

  it('fires input as an InputEvent and change as non-cancelable', () => {
    const input = collectCandidates(fragment('<input>'))[0] as HTMLInputElement;
    let inputEvent: Event | undefined;
    let changeEvent: Event | undefined;
    input.addEventListener('input', (event) => (inputEvent = event));
    input.addEventListener('change', (event) => (changeEvent = event));

    applyValue(input, 'value', { dispatchEvents: true });

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

    applyValue(input, 'quiet', { dispatchEvents: false });

    expect(input.value).toBe('quiet');
    expect(seen).toEqual([]);
  });

  it('fills a textarea through its own prototype setter', () => {
    const area = collectCandidates(fragment('<textarea></textarea>'))[0] as HTMLTextAreaElement;
    applyValue(area, 'paragraph', { dispatchEvents: true });
    expect(area.value).toBe('paragraph');
  });

  it('throws for an element that holds no value, rather than failing silently', () => {
    const div = fragment('<div contenteditable="true"></div>').firstElementChild!;
    // Phase 2 gives contenteditable the same exclusion and event path as any
    // other control (A7, D8). Until then it must fail loudly, and the caller
    // isolates it per field (BR-004-11).
    expect(() => applyValue(div, 'x', { dispatchEvents: false })).toThrow();
  });
});
