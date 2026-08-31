import { beforeEach, describe, expect, it } from 'vitest';
import { resolveScope, watchAnchor } from '@/lib/page/scope';
import { excludedBy, matchesGlob } from '@/lib/globs';
import { runFill } from '@/lib/page/fill-loop';
import { realScheduler } from '@/lib/page/settle';
import { generateBatch, tokenRandom } from '@/lib/generators/batch';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import type { AgentSettings } from '@/lib/protocol';

/**
 * DD-008 — what "the current form" and "the selected input" resolve to.
 *
 * The ladder is the whole design, and the reason it is a ladder rather than a
 * heuristic is that the answer has to be predictable. That makes each rung worth
 * a test on its own, and the two refusals worth more than the rungs: they are
 * where a scope the user narrowed could quietly widen.
 */

const SETTINGS: AgentSettings = {
  dispatchEvents: true,
  skipHidden: false,
  skipPreFilled: false,
  ignorePatterns: [],
};

function page(html: string): void {
  document.body.innerHTML = html;
}

const at = (selector: string): Element => document.querySelector(selector)!;

async function fill(options: Omit<Parameters<typeof runFill>[0], 'settings' | 'writtenByUs' | 'requestValues' | 'scheduler'>) {
  const seed = 3;
  const shared = seededRandom(seed);
  const persona = createPersona(seededRandom(seed));
  return runFill({
    scheduler: realScheduler,
    settings: SETTINGS,
    writtenByUs: new WeakSet<Element>(),
    requestValues: (descriptors) =>
      Promise.resolve(
        generateBatch(descriptors, {
          persona,
          randomFor: (token) => (token === undefined ? shared : tokenRandom(seed, token)),
        }).values,
      ),
    ...options,
  });
}

const filled = (selector: string): string => (at(selector) as HTMLInputElement).value;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the form-scope ladder (DD-008, BR-002-1)', () => {
  it('rule 1: takes the form the page says the control belongs to', () => {
    page(`<form id="owner"><input name="a"></form>`);

    const resolution = resolveScope('current-form', document, at('[name="a"]'));

    expect(resolution).toMatchObject({ resolved: true, rule: 'element-form' });
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    expect(resolution.within).toBe(at('#owner'));
  });

  it('rule 1: follows the form attribute, where closest() would not', () => {
    // A control associated by `form="id"` rather than by containment — the shape
    // a modal or a sticky footer produces, and one `closest("form")` gets wrong
    // in both directions (ND-3's class of fix).
    page(`
      <form id="owner"><button type="submit">Go</button></form>
      <div id="elsewhere"><input name="a" form="owner"></div>`);

    const resolution = resolveScope('current-form', document, at('[name="a"]'));

    expect(resolution).toMatchObject({ rule: 'element-form' });
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    expect(resolution.within).toBe(at('#owner'));
    // The give-away that this is not `closest`: the anchor is not inside it.
    expect(at('#owner').contains(at('[name="a"]'))).toBe(false);
  });

  it('rule 1: fills the control it resolved from, not just the form around it', async () => {
    // The other half of the rule, and the half that was missing. Resolving to a
    // form the anchor is *outside* of is the whole point — and a walk of the
    // form's subtree then found every field except the one the user pointed at.
    // "Fill this form" filled everything around the anchor and left it blank,
    // which is a worse answer than refusing would have been.
    page(`
      <form id="owner"><input name="inside"><button type="submit">Go</button></form>
      <div id="modal"><input name="anchor" form="owner"></div>`);

    const resolution = resolveScope('current-form', document, at('[name="anchor"]'));
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    await fill({ root: document, within: resolution.within });

    expect(filled('[name="inside"]')).not.toBe('');
    expect(filled('[name="anchor"]')).not.toBe('');
  });

  it('rule 1: does not reach controls the form does not own', async () => {
    // `form.elements` is the page's own answer to what the form submits, so the
    // widening stops exactly where the page says it does.
    page(`
      <form id="owner"><input name="inside"><button type="submit">Go</button></form>
      <div id="modal"><input name="anchor" form="owner"><input name="unrelated"></div>`);

    const resolution = resolveScope('current-form', document, at('[name="anchor"]'));
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    await fill({ root: document, within: resolution.within });

    expect(filled('[name="anchor"]')).not.toBe('');
    expect(filled('[name="unrelated"]')).toBe('');
  });

  it('rule 2: takes what the author declared without a form tag', () => {
    page(`<div id="unit" role="form"><input name="a"></div>`);

    const resolution = resolveScope('current-form', document, at('[name="a"]'));

    expect(resolution).toMatchObject({ rule: 'role-form' });
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    expect(resolution.within).toBe(at('#unit'));
  });

  it('rule 3: takes the smallest block holding the field and a submit control', () => {
    page(`
      <div id="outer">
        <div id="inner"><input name="a"><button>Save</button></div>
        <input name="b">
      </div>`);

    const resolution = resolveScope('current-form', document, at('[name="a"]'));

    expect(resolution).toMatchObject({ rule: 'submit-container' });
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    // The smallest, not the first one found walking down.
    expect(resolution.within).toBe(at('#inner'));
  });

  it('rule 3: does not accept a button that submits nothing', () => {
    // `type="button"` and a `role="button"` toggle are on every page. Admitting
    // them would make rule 3 match a container that cannot be submitted.
    page(`<div id="outer"><input name="a"><button type="button">Toggle</button></div>`);

    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: false,
      reason: 'no-form-around-anchor',
    });
  });

  it('rule 3: does not accept one inside a role="form" either', () => {
    // The same toggle, moved into a `[role="form"]` container the anchor is not
    // in. A `[role="form"] button` clause used to match a button of any type,
    // so this widened to `#outer` — the assertion above passing only because its
    // toggle happened to sit outside such a container.
    page(`
      <div id="outer">
        <input name="a">
        <div role="form"><button type="button">Toggle</button></div>
      </div>`);

    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: false,
      reason: 'no-form-around-anchor',
    });
  });

  it('rule 3: still accepts a real submit inside a role="form"', () => {
    // The clause was removed rather than narrowed, so this is the check that it
    // was removing nothing: a button that does submit is matched wherever it is.
    page(`
      <div id="outer">
        <input name="a">
        <div role="form"><button>Save</button></div>
      </div>`);

    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: true,
      rule: 'submit-container',
    });
  });

  it('rule 4: refuses even when the page has a submit button somewhere else', () => {
    // The version of rule 4 that actually bites. Almost every page has *a*
    // submit button, so a walk that lets `<body>` be a candidate returns the
    // whole page — the page scope under the form scope's name. Caught by the
    // end-to-end harness, which filled all four blocks of its fixture.
    page(`
      <form id="other"><input name="b"><button type="submit">Save</button></form>
      <div id="loose"><input name="a"><button type="button">Toggle</button></div>`);

    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: false,
      reason: 'no-form-around-anchor',
    });
  });

  it('rule 4: refuses rather than widening, when the user pointed at something', () => {
    // BR-002-2. Widening here would fill the other form on the page — the one the
    // Tester was avoiding by narrowing in the first place.
    page(`
      <div><input name="a"></div>
      <form id="other"><input name="b"></form>`);

    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: false,
      reason: 'no-form-around-anchor',
    });
  });
});

describe('the anchorless case (UC-002 A2)', () => {
  it('fills the only form-like unit when there is exactly one', () => {
    page(`<form id="only"><input name="a"></form>`);

    const resolution = resolveScope('current-form', document, undefined);

    expect(resolution).toMatchObject({ rule: 'only-unit' });
    if (!resolution.resolved || !('within' in resolution)) throw new Error('expected a root');
    expect(resolution.within).toBe(at('#only'));
  });

  it('widens to the page when there are none', () => {
    page(`<div><input name="a"></div>`);
    expect(resolveScope('current-form', document, undefined)).toMatchObject({
      rule: 'whole-page',
    });
  });

  it('widens to the page when two or more compete', () => {
    // A superset cannot be wrong about which one was meant; a guess silently
    // fails whenever the other was wanted.
    page(`<form><input name="a"></form><form><input name="b"></form>`);
    expect(resolveScope('current-form', document, undefined)).toMatchObject({
      rule: 'whole-page',
    });
  });

  it('is the opposite decision to an anchored failure, on the same page', () => {
    // The asymmetry stated as one assertion, because it reads as an
    // inconsistency until you see that only one of them overrides an intent.
    page(`<div><input name="a"></div><div><input name="b"></div>`);

    expect(resolveScope('current-form', document, undefined)).toMatchObject({ resolved: true });
    expect(resolveScope('current-form', document, at('[name="a"]'))).toMatchObject({
      resolved: false,
    });
  });
});

describe('the single-control scope (UC-003)', () => {
  it('refuses with no anchor, because there is nothing to widen to', () => {
    page(`<input name="a">`);
    expect(resolveScope('selected-input', document, undefined)).toMatchObject({
      resolved: false,
      reason: 'no-anchor',
    });
  });

  it('resolves to the pointed-at control alone', () => {
    page(`<input name="a"><input name="b">`);
    expect(resolveScope('selected-input', document, at('[name="a"]'))).toMatchObject({
      resolved: true,
      rule: 'anchor-control',
      only: at('[name="a"]'),
    });
  });
});

describe('filling at a scope', () => {
  it('writes inside the form and nothing outside it', async () => {
    page(`
      <form id="target"><input name="inside"></form>
      <form id="other"><input name="outside"></form>`);

    const result = await fill({ root: document, within: at('#target') });

    expect(filled('[name="inside"]')).not.toBe('');
    // BR-002-3: the root is walked, never the page walked and filtered — so a
    // control outside it is not merely skipped, it is never seen.
    expect(filled('[name="outside"]')).toBe('');
    expect(result.outcomes).toHaveLength(1);
  });

  it('writes one control and not the ones beside it', async () => {
    page(`<input name="a"><input name="b">`);

    const result = await fill({ root: document, only: at('[name="a"]') });

    expect(filled('[name="a"]')).not.toBe('');
    expect(filled('[name="b"]')).toBe('');
    expect(result.outcomes).toHaveLength(1);
  });

  it('answers a radio group when one of its buttons is the anchor', async () => {
    // UC-003 A4: a radio button is not independently fillable, so the unit is
    // the group and exactly one member ends up selected — possibly not the one
    // pointed at.
    page(`
      <input type="radio" name="pick" value="yes">
      <input type="radio" name="pick" value="no">
      <input name="untouched">`);

    await fill({ root: document, only: at('[value="yes"]') });

    const chosen = document.querySelectorAll<HTMLInputElement>('[name="pick"]:checked');
    expect(chosen).toHaveLength(1);
    expect(filled('[name="untouched"]')).toBe('');
  });

  it('does not fill what the page reveals in response (UC-003 A6)', async () => {
    page(`<input name="a"><div id="extra" hidden><input name="revealed"></div>`);
    at('[name="a"]').addEventListener('input', () => {
      (at('#extra') as HTMLElement).hidden = false;
    });

    await fill({ root: document, only: at('[name="a"]') });

    // The cascade is followed to make our own write stick, never to widen a
    // scope the Tester narrowed to one control.
    expect(filled('[name="revealed"]')).toBe('');
  });
});

/**
 * A right-click the browser sent, rather than one a page dispatched.
 *
 * The watcher ignores untrusted `contextmenu` events, so a plain
 * `dispatchEvent` no longer stands in for a user — which is the point of the
 * guard, and the reason this helper exists rather than the tests asserting
 * against a weaker input than production sees.
 */
function rightClick(element: Element): void {
  const event = new Event('contextmenu', { bubbles: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  element.dispatchEvent(event);
}

describe('finding the anchor (DD-008)', () => {
  it('prefers where the user pointed over what is focused, for a menu fill', () => {
    page(`<input name="pointed"><input name="focused">`);
    const watch = watchAnchor(document);
    try {
      (at('[name="focused"]') as HTMLElement).focus();
      rightClick(at('[name="pointed"]'));

      expect(watch.anchor('menu')).toBe(at('[name="pointed"]'));
    } finally {
      watch.release();
    }
  });

  it('falls back to the last control focused this page lifetime', () => {
    // Tab through a form, click something neutral, then use the shortcut. Common
    // enough that without it the Tester presses a key and watches nothing happen.
    page(`<input name="a"><div id="neutral">text</div>`);
    const watch = watchAnchor(document);
    try {
      at('[name="a"]').dispatchEvent(new Event('focusin', { bubbles: true }));
      (at('[name="a"]') as HTMLElement).blur();

      expect(watch.anchor('shortcut')).toBe(at('[name="a"]'));
    } finally {
      watch.release();
    }
  });

  it('has no anchor on a page the user has not touched', () => {
    page(`<input name="a">`);
    const watch = watchAnchor(document);
    try {
      expect(watch.anchor('shortcut')).toBeUndefined();
    } finally {
      watch.release();
    }
  });

  it('forgets an anchor the page has removed', () => {
    page(`<input name="a">`);
    const watch = watchAnchor(document);
    try {
      rightClick(at('[name="a"]'));
      document.body.innerHTML = '';

      // BR-003-2: the anchor is an element, not a place. A page that re-rendered
      // has replaced the control, and whatever now sits there is a different one.
      expect(watch.anchor('menu')).toBeUndefined();
    } finally {
      watch.release();
    }
  });

  describe('a right-click does not steer later keyboard fills (UC-002 A1)', () => {
    it('takes what is focused for a shortcut, even after a right-click elsewhere', () => {
      page(`<input name="pointed"><input name="focused">`);
      const watch = watchAnchor(document);
      try {
        rightClick(at('[name="pointed"]'));
        (at('[name="focused"]') as HTMLElement).focus();

        // A1: a shortcut was not aimed at anything, so it takes the focused
        // element. The right-click belongs to the menu fill it opened, and to
        // nothing after it.
        expect(watch.anchor('shortcut')).toBe(at('[name="focused"]'));
        expect(watch.anchor('toolbar')).toBe(at('[name="focused"]'));
        // The same watcher still answers a menu fill with the pointer.
        expect(watch.anchor('menu')).toBe(at('[name="pointed"]'));
      } finally {
        watch.release();
      }
    });

    it('does not let one right-click on blank background poison the page', () => {
      // The reported trap, and the reason this is two guards rather than one:
      // `<body>` stays connected for as long as the page lives, so once it
      // became the pointer it outranked every other source forever. Every later
      // shortcut refused with "no form found" while a field sat focused.
      page(`<form id="f"><input name="a"><button>Go</button></form>`);
      const watch = watchAnchor(document);
      try {
        rightClick(document.body);
        (at('[name="a"]') as HTMLElement).focus();

        expect(watch.anchor('shortcut')).toBe(at('[name="a"]'));
        // Even a menu fill never sees `<body>`: a right-click on blank page
        // background is not pointing *at* anything (A1's second trigger).
        expect(watch.anchor('menu')).toBe(at('[name="a"]'));

        const resolved = resolveScope('current-form', document, watch.anchor('shortcut'));
        expect(resolved).toEqual({ resolved: true, within: at('#f'), rule: 'element-form' });
      } finally {
        watch.release();
      }
    });

    it('ignores a contextmenu event the page dispatched itself', () => {
      // Between a real right-click and the user choosing our menu item, a page
      // could otherwise move the anchor to a control of its own choosing. The
      // pointer is the one anchor source with no on-screen trace, so a page
      // steering it is not visible to the user at all.
      page(`<input name="planted"><input name="focused">`);
      const watch = watchAnchor(document);
      try {
        at('[name="planted"]').dispatchEvent(new Event('contextmenu', { bubbles: true }));
        (at('[name="focused"]') as HTMLElement).focus();

        expect(watch.anchor('menu')).toBe(at('[name="focused"]'));
      } finally {
        watch.release();
      }
    });
  });

  describe('focus inside a frame is not an anchor (UC-002 A2, UC-003 A2)', () => {
    // A shortcut is routed to the top frame, and `activeElement` there is the
    // `<iframe>` element whenever focus is inside the child document. It is
    // connected and it is not `<body>`, so it used to be taken as the anchor:
    // "fill this input" then reported an `<iframe>` as an unfillable control,
    // and "fill this form" resolved a container around it and filled a form the
    // user was not working in.
    it('does not take the frame element the user is typing inside', () => {
      page(`<form id="f"><input name="a"><button>Go</button></form><iframe id="frame"></iframe>`);
      const watch = watchAnchor(document);
      try {
        // What the top document reports while focus sits in the child.
        at('#frame').dispatchEvent(new Event('focusin', { bubbles: true }));

        expect(watch.anchor('shortcut')).toBeUndefined();
        // Widening is the right answer here, and one the user can read.
        expect(resolveScope('current-form', document, watch.anchor('shortcut'))).toMatchObject({
          resolved: true,
          rule: 'only-unit',
        });
        // The control scope has nothing to widen to, so it refuses (UC-003 A2)
        // rather than naming a frame as a control.
        expect(resolveScope('selected-input', document, watch.anchor('shortcut'))).toEqual({
          resolved: false,
          reason: 'no-anchor',
        });
      } finally {
        watch.release();
      }
    });

    it('does not take a frame the user right-clicked either', () => {
      page(`<iframe id="frame"></iframe>`);
      const watch = watchAnchor(document);
      try {
        rightClick(at('#frame'));
        expect(watch.anchor('menu')).toBeUndefined();
      } finally {
        watch.release();
      }
    });
  });
});

describe('domain exclusion patterns (UC-008, FR-037)', () => {
  it.each([
    ['https://bank.example.com/login', 'bank.example.com/*', true],
    ['https://bank.example.com/login', '*.example.com/*', true],
    ['https://secure.example.com/x', '*.example.com/*', true],
    // `*.example.com` requires the dot, so the bare domain is not a subdomain of
    // itself. A user who wants both writes `example.com/*` or lists both.
    ['https://example.com/x', '*.example.com/*', false],
    ['https://example.com/pay', 'https://example.com/*', true],
    ['http://example.com/pay', 'https://example.com/*', false],
    ['https://example.com/pay', 'example.org/*', false],
    ['https://EXAMPLE.com/Pay', 'example.com/*', true],
  ])('%s against %s', (url, pattern, expected) => {
    expect(matchesGlob(url, pattern)).toBe(expected);
  });

  it('treats a bare domain as any scheme, which is how a user writes one', () => {
    expect(matchesGlob('https://example.com/', 'example.com/*')).toBe(true);
    expect(matchesGlob('http://example.com/', 'example.com/*')).toBe(true);
  });

  describe('the port takes no part in matching, on either side (FR-037)', () => {
    // Extension match patterns have no port and ignore the one the page is
    // served on. Ours claimed that vocabulary and did not implement it, so every
    // exclusion on a ported URL silently did not apply — failing *open*, which
    // for FR-074 is the direction that matters.
    it.each([
      ['http://localhost:3000/app', 'localhost/*'],
      ['http://127.0.0.1:8080/x', '127.0.0.1/*'],
      // Not only a dev-server concern: an exclusion on a bank served over a
      // non-default HTTPS port was silently inert too.
      ['https://bank.example.com:8443/login', 'bank.example.com/*'],
      ['https://bank.example.com:8443/login', '*.example.com/*'],
      // A host with no path at all is still the root that `/*` covers.
      ['http://localhost:3000', 'localhost/*'],
      // IPv6 keeps its brackets; only a trailing `:digits` is a port.
      ['http://[::1]:8080/x', '[::1]/*'],
    ])('%s is excluded by %s', (url, pattern) => {
      expect(matchesGlob(url, pattern)).toBe(true);
    });

    it('reads a port the user typed as the host, rather than never matching', () => {
      // Chrome would call this pattern malformed. Voiding it would be the silent
      // failure again, so it widens to the host instead — safe for an exclusion
      // in a way that matching nothing is not.
      expect(matchesGlob('http://localhost:3000/app', 'localhost:3000/*')).toBe(true);
      expect(matchesGlob('http://localhost:9999/app', 'localhost:3000/*')).toBe(true);
    });

    it('does not let a port make a pattern match a different host', () => {
      expect(matchesGlob('https://evil.test/?next=localhost/', 'localhost/*')).toBe(false);
      expect(matchesGlob('http://localhost.evil.test:3000/', 'localhost/*')).toBe(false);
    });

    it('names the pattern for a ported URL, so the report can show it', () => {
      expect(excludedBy('http://127.0.0.1:5173/form', ['127.0.0.1/*'])).toBe('127.0.0.1/*');
    });
  });

  describe('a pattern matches parts, not the URL as a string (FR-037, BR-008-6)', () => {
    // Matching the glob against the whole URL made every literal a substring
    // test, so a host a pattern names counted wherever it appeared — including
    // in somebody else's query string or fragment. Fail-closed, so the damage is
    // a page the user never listed silently refusing to fill; and `matchesGlob`
    // is also Phase 5's profile matcher, where over-matching changes which rules
    // run rather than whether a fill happens.
    it.each([
      ['https://evil.test/?redirect=https://sub.example.com/', '*.example.com/*', 'a query string'],
      ['https://evil.test/?next=https://localhost/', 'localhost/*', 'a query string'],
      ['https://evil.test/#https://bank.example.com/login', 'bank.example.com/*', 'a fragment'],
      // The host is what the browser resolved. This page is on `evil.test`.
      ['https://example.com@evil.test/', 'example.com/*', 'the userinfo'],
    ])('does not match %s just because %s names the host', (url, pattern) => {
      expect(matchesGlob(url, pattern)).toBe(false);
    });

    it('still matches the host it really is, credentials and all', () => {
      expect(matchesGlob('https://user:pw@example.com/x', 'example.com/*')).toBe(true);
    });
  });

  describe('a bare host covers any path on it (FR-037)', () => {
    // Someone typing into a field labelled "excluded domains" means the domain.
    // Reading it as "the root and nothing else" would be the silent failure the
    // port fix exists to remove, wearing a different hat.
    it.each([
      ['https://example.com/pay', true],
      ['https://example.com/', true],
      ['https://evil.test/?next=example.com', false],
      ['https://notexample.com/', false],
    ])('%s against a bare example.com is %s', (url, expected) => {
      expect(matchesGlob(url, 'example.com')).toBe(expected);
    });
  });

  describe('matching is linear, not a regular expression (NFR-009)', () => {
    // Translating `*` to `.*` was the obvious implementation and it is the
    // textbook catastrophic-backtracking shape. Measured against the old one,
    // this pattern took 3 ms at 20 trailing characters, 3.2 s at 40 and 33 s at
    // 50 — in a check that runs before every fill, on a string a page controls.
    const evil = 'example.test/*a*a*a*a*a*a*a*a*a*z';

    it('answers a pathological pattern in constant time', () => {
      const started = Date.now();
      expect(matchesGlob(`https://example.test/${'a'.repeat(50_000)}`, evil)).toBe(false);
      // Three orders of magnitude of headroom against the old 33 s at 50
      // characters, and this input is a thousand times longer.
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('still matches what that pattern describes', () => {
      // The bound is worthless if it was bought by making the matcher wrong.
      expect(matchesGlob('https://example.test/aaaaaaaaaz', evil)).toBe(true);
      expect(matchesGlob('https://example.test/aaaaaaaaaq', evil)).toBe(false);
    });

    it('keeps every star meaningful, wherever it sits', () => {
      expect(matchesGlob('https://example.com/a/b/c', '*://*/a/*')).toBe(true);
      expect(matchesGlob('https://example.com/x', '*://*/a/*')).toBe(false);
      // The anchors must not overlap: `ab*ba` cannot match `aba` by sharing one.
      expect(matchesGlob('https://aba.test/', '*://ab*ba.test/')).toBe(false);
    });
  });

  it('does not let a pattern character become a wildcard by accident', () => {
    // `.` is a literal here. Reading it as a regex would make `bank.example.com`
    // match `bankXexample.com`, which is an exclusion silently not applying.
    expect(matchesGlob('https://bankxexample.com/', 'bank.example.com/*')).toBe(false);
  });

  it('names the pattern that excluded a URL, so the user can find it', () => {
    const patterns = ['*.internal.test/*', 'bank.example.com/*'];
    expect(excludedBy('https://bank.example.com/login', patterns)).toBe('bank.example.com/*');
    expect(excludedBy('https://example.com/', patterns)).toBeUndefined();
  });

  it('excludes nothing when the list is empty', () => {
    // UC-008 A2: an empty list is a new install, not "exclude everything".
    expect(excludedBy('https://anything.test/', [])).toBeUndefined();
  });
});

describe('an anchor the page removed is a failure (UC-003 A5)', () => {
  it('reports the control failed, with a cause, rather than an empty fill', async () => {
    // "0 filled in this field" is what this used to say, which is what a scope
    // that resolved and found nothing fillable says too. A5 requires the
    // control be reported failed with the cause, and the distinction is the same
    // one refusals get: a decision must not read as an empty result.
    page(`<div id="host"><input name="a"></div>`);
    const anchor = at('[name="a"]');
    at('#host').replaceChildren();

    const result = await fill({ root: document, only: anchor });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ status: 'failed' });
    expect((result.outcomes[0] as { cause: string }).cause).toContain('removed');
  });

  it('says nothing extra when the anchor is still there', async () => {
    page(`<input name="a">`);
    const result = await fill({ root: document, only: at('[name="a"]') });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ status: 'filled' });
  });
});

describe('a control inside an open shadow root is the anchor (FR-008, C-006)', () => {
  // Retargeting is the platform working as designed: a listener on the document
  // sees the shadow *host*, not the control inside it. It silently defeated both
  // scopes on exactly the design systems `walk.ts` goes out of its way to
  // support — a host is not a fillable kind, so "fill this input" refused.
  //
  // happy-dom does not emulate retargeting for `event.target`, so the focus half
  // is what these can prove; the pointer half is covered by `e2e-scopes.mjs`,
  // which drives a real browser. That split is the reason the defect survived:
  // no unit test could have caught it.
  function component(): { host: Element; inner: HTMLInputElement } {
    page(`<form id="f"><div id="host"></div><button type="submit">Go</button></form>`);
    const host = at('#host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<input id="inner">`;
    return { host, inner: root.querySelector('#inner') as HTMLInputElement };
  }

  it('follows focus into the component rather than stopping at the host', () => {
    const { host, inner } = component();
    inner.focus();
    // What the document reports, and what used to become the anchor.
    expect(document.activeElement).toBe(host);

    const watch = watchAnchor(document);
    try {
      expect(watch.anchor('shortcut')).toBe(inner);
    } finally {
      watch.release();
    }
  });

  it('resolves the single-control scope to the control, not the component', () => {
    const { inner } = component();
    expect(resolveScope('selected-input', document, inner)).toEqual({
      resolved: true,
      only: inner,
      rule: 'anchor-control',
    });
  });

  it('finds the form outside the component the control lives in', () => {
    // `closest` and `parentElement` both stop at the shadow root, so a ladder
    // that does not hop out to the host refuses — on a control whose form is
    // sitting right there in the light DOM.
    const { inner } = component();
    expect(resolveScope('current-form', document, inner)).toMatchObject({
      resolved: true,
      rule: 'element-form',
      within: at('#f'),
    });
  });

  it('reaches a submit container outside the component too', () => {
    page(`<div id="block"><div id="host"></div><button>Save</button></div>`);
    const root = at('#host').attachShadow({ mode: 'open' });
    root.innerHTML = `<input id="inner">`;
    const inner = root.querySelector('#inner') as HTMLInputElement;

    expect(resolveScope('current-form', document, inner)).toMatchObject({
      resolved: true,
      rule: 'submit-container',
      within: at('#block'),
    });
  });
});
