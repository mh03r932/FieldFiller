import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFill, type Bounds, type ValueSource } from '@/lib/page/fill-loop';
import { realScheduler, type Scheduler } from '@/lib/page/settle';
import { generateBatch, tokenRandom } from '@/lib/generators/batch';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import type { AgentSettings, FieldOutcome } from '@/lib/protocol';

/**
 * The DD-009 fixture matrix, without a browser.
 *
 * `scripts/e2e-cascade.mjs` runs the same shapes against a real Chromium with
 * the real extension loaded, and it is the harness that decides whether the
 * feature works. This file exists because that one is slow to run, slow to
 * reproduce, and tells you only that *something* on the page came out wrong —
 * NFR-015's whole argument, and the reason DD-009 made the scheduler a
 * parameter.
 *
 * Timings are compressed by two orders of magnitude rather than faked: a real
 * `MutationObserver` and real timers, with the page's own reactions in the same
 * proportion to the bounds as they are in the wild. A virtual clock would have
 * to be shared with the page's handlers, and the page is exactly the thing whose
 * timing we do not control.
 */

const BOUNDS: Bounds = {
  maxPasses: 8,
  quietMs: 25,
  maxQuietWaitMs: 120,
  cascadeBudgetMs: 2000,
  writeAttempts: 3,
  comboboxControlMs: 200,
  comboboxPassMs: 1000,
};

const SETTINGS: AgentSettings = {
  dispatchEvents: true,
  skipHidden: false,
  skipPreFilled: false,
  ignorePatterns: [],
};

/**
 * The real background half of the round trip, not a stub.
 *
 * FR-080 is a property of `generateBatch` and the loop *together* — the loop
 * supplies a stable token, the background turns it into a stable value — so a
 * fake value source would test neither side of the thing that matters.
 */
function background(seed = 7): ValueSource {
  const shared = seededRandom(seed);
  const persona = createPersona(seededRandom(seed));
  return (descriptors) =>
    Promise.resolve(
      generateBatch(descriptors, {
        persona,
        randomFor: (token) => (token === undefined ? shared : tokenRandom(seed, token)),
      }),
    );
}

async function fill(
  source: ValueSource = background(),
  bounds: Bounds = BOUNDS,
  settings: AgentSettings = SETTINGS,
) {
  return runFill({
    root: document,
    settings,
    writtenByUs: new WeakSet<Element>(),
    requestValues: source,
    bounds,
    scheduler: realScheduler,
  });
}

function page(html: string, script?: () => void): void {
  document.body.innerHTML = html;
  script?.();
}

const field = (name: string): HTMLInputElement | HTMLSelectElement =>
  document.querySelector(`[name="${name}"]`)!;

const value = (name: string): string => field(name).value;

const options = (select: HTMLSelectElement, items: readonly string[]): void => {
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose…';
  select.append(placeholder);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    select.append(option);
  }
};

const statuses = (outcomes: readonly FieldOutcome[]): string[] =>
  outcomes.map((outcome) => outcome.status);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a page whose fields depend on an earlier answer', () => {
  it('fills a dependent select from the options the page wrote after the first answer', async () => {
    page(
      `<select name="country"><option value=""></option><option value="gb">GB</option></select>
       <select name="county"><option value=""></option></select>`,
      () => {
        field('country').addEventListener('change', () => {
          options(field('county') as HTMLSelectElement, ['devon', 'yorkshire']);
        });
      },
    );

    const result = await fill();

    expect(value('country')).not.toBe('');
    // The case the whole decision exists for: a single-pass fill describes this
    // control when its only option is the placeholder, and leaves it empty.
    expect(value('county')).not.toBe('');
    expect(result.capped).toBeUndefined();
  });

  it('settles a chain three levels deep, which is what makes it a fixpoint and not a retry', async () => {
    page(
      `<select name="region"><option value=""></option><option value="north">N</option></select>
       <select name="district"><option value=""></option></select>
       <select name="ward"><option value=""></option></select>`,
      () => {
        field('region').addEventListener('change', () => {
          options(field('district') as HTMLSelectElement, ['dales']);
        });
        field('district').addEventListener('change', () => {
          options(field('ward') as HTMLSelectElement, ['upper']);
        });
      },
    );

    const result = await fill();

    expect([value('region'), value('district'), value('ward')]).toEqual(['north', 'dales', 'upper']);
    expect(result.passes).toBeGreaterThanOrEqual(3);
    expect(result.capped).toBeUndefined();
  });

  it('waits for a debounced cascade rather than sampling the page too early', async () => {
    page(
      `<select name="carrier"><option value=""></option><option value="air">Air</option></select>
       <select name="service"><option value=""></option></select>`,
      () => {
        field('carrier').addEventListener('change', () => {
          // Clears synchronously, repopulates later — the shape that defeats
          // every fixed-sleep design, and the reason quiescence is a timer that
          // the page's own first reaction restarts.
          options(field('service') as HTMLSelectElement, []);
          setTimeout(() => options(field('service') as HTMLSelectElement, ['express']), 20);
        });
      },
    );

    await fill();

    expect(value('service')).toBe('express');
  });

  it('fills fields the page revealed only after an earlier answer', async () => {
    page(
      `<select name="type"><option value=""></option><option value="business">B</option></select>
       <div id="extra" hidden><input name="company"><input name="vat"></div>`,
      () => {
        field('type').addEventListener('change', () => {
          document.getElementById('extra')!.hidden = false;
        });
      },
    );

    await fill();

    expect(value('company')).not.toBe('');
    expect(value('vat')).not.toBe('');
  });

  it('re-decides an exclusion instead of remembering it, so a control the page enables is filled', async () => {
    page(
      `<select name="plan"><option value=""></option><option value="team">T</option></select>
       <input name="seats" disabled>`,
      () => {
        field('plan').addEventListener('change', () => {
          field('seats').removeAttribute('disabled');
        });
      },
    );

    const result = await fill();

    // The reason it was excluded in pass 1 was a statement about pass 1 alone
    // (UC-034 A2, BR-034-7).
    expect(value('seats')).not.toBe('');
    expect(statuses(result.outcomes)).toEqual(['filled', 'filled']);
  });
});

describe('a page that undoes what was written', () => {
  it('notices a wipe that produced no mutation record at all', async () => {
    let wiped = false;
    page(`<input name="reference">`, () => {
      field('reference').addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        if (wiped || target.value === '') return;
        wiped = true;
        // A property assignment. It emits no mutation record of any kind, so a
        // loop that took its diff from the observer would be blind to precisely
        // the failure it was built to catch (BR-034-8).
        setTimeout(() => (target.value = ''), 5);
      });
    });

    const result = await fill();

    expect(value('reference')).not.toBe('');
    expect(statuses(result.outcomes)).toEqual(['filled']);
  });

  it('stops at a bound and reports the field failed when the page reverts every write', async () => {
    page(`<input name="coupon">`, () => {
      field('coupon').addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        if (target.value !== '') target.value = '';
      });
    });

    const result = await fill();

    // Never `filled`. A page with no fixpoint produces a bounded honest failure,
    // which per vision.md §3 is the correct behaviour and not a compromise.
    expect(statuses(result.outcomes)).toEqual(['failed']);
    expect(result.passes).toBeLessThanOrEqual(BOUNDS.maxPasses);
  });

  it('lets the rest of the page settle rather than letting one hostile field cap the fill', async () => {
    page(`<input name="coupon"><input name="ordinary">`, () => {
      field('coupon').addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        if (target.value !== '') target.value = '';
      });
    });

    const result = await fill();

    // Without the per-control write cap this reports `capped`, and every other
    // field on the page is described to the user as possibly stale because of
    // one broken one.
    expect(result.capped).toBeUndefined();
    expect(statuses(result.outcomes)).toEqual(['failed', 'filled']);
  });

  it('does not report a control the page removed, and fills the one that replaced it', async () => {
    let replaced = false;
    page(
      `<select name="delivery"><option value=""></option><option value="standard">S</option></select>`,
      () => {
        field('delivery').addEventListener('change', () => {
          if (replaced) return;
          replaced = true;
          setTimeout(() => {
            const old = field('delivery');
            const fresh = old.cloneNode(true) as HTMLSelectElement;
            fresh.value = '';
            old.replaceWith(fresh);
          }, 5);
        });
      },
    );

    const result = await fill();

    // Two elements were written; one of them is not on the settled page. The
    // report is an account of the page as it settled (UC-034 A7).
    expect(value('delivery')).toBe('standard');
    expect(statuses(result.outcomes)).toEqual(['filled']);
  });

  it('gives a control the same value the second time the page makes us write it', async () => {
    const seen: string[] = [];
    let wiped = false;
    page(`<input name="email" type="email">`, () => {
      field('email').addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        if (target.value === '') return;
        seen.push(target.value);
        if (wiped) return;
        wiped = true;
        setTimeout(() => (target.value = ''), 5);
      });
    });

    await fill();

    // FR-080. Two writes, one value: otherwise a field and its confirmation
    // drift apart whenever the page forces a second write, and the defect
    // appears only on pages that cascade (BR-034-3).
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('bounds and the user', () => {
  it('caps a page that keeps producing new fields, and says how much may be stale', async () => {
    // Delegated from a wrapper rather than from `document.body`, which survives
    // `innerHTML = ''` and would keep growing every later test's page.
    page(`<div id="grow"><input name="f0"></div>`, () => {
      // Every answer reveals another question. There is no fixpoint, and no
      // per-control cap can find one, because no single control is at fault.
      const grow = document.getElementById('grow')!;
      let next = 1;
      grow.addEventListener('input', () => {
        const grown = document.createElement('input');
        grown.name = `f${next++}`;
        grow.append(grown);
      });
    });

    const result = await fill();

    expect(result.capped).toBe('pass-cap');
    expect(result.passes).toBe(BOUNDS.maxPasses);
    // FR-078: the user is told how many fields the fill did not get to, rather
    // than being shown a count that looks clean.
    expect(result.stale).toBeGreaterThan(0);
  });

  it('terminates two controls that rewrite each other without capping the whole fill', async () => {
    page(
      `<select name="a"><option value=""></option><option value="1">1</option></select>
       <select name="b"><option value=""></option></select>`,
      () => {
        field('a').addEventListener('change', () => {
          options(field('b') as HTMLSelectElement, [String(Math.random())]);
        });
        field('b').addEventListener('change', () => {
          options(field('a') as HTMLSelectElement, [String(Math.random())]);
        });
      },
    );

    const result = await fill();

    // A circular dependency has no fixpoint either, but the fault is local to
    // two controls — so their own write caps end it and the page is not reported
    // as one the engine could not settle.
    expect(result.capped).toBeUndefined();
    expect(result.passes).toBeLessThan(BOUNDS.maxPasses);
  });

  it('stops the cascade and leaves a control alone once the user touches it', async () => {
    page(
      `<select name="type"><option value=""></option><option value="business">B</option></select>
       <input name="notes">`,
      () => {
        field('type').addEventListener('change', () => {
          // The user starts typing while the fill is still running. In happy-dom
          // a dispatched event is untrusted, exactly as ours are, so the flag is
          // set the way the platform would set it.
          const typed = new Event('input', { bubbles: true });
          Object.defineProperty(typed, 'isTrusted', { value: true });
          field('notes').dispatchEvent(typed);
        });
      },
    );

    const result = await fill();

    expect(result.capped).toBe('user-input');
    // BR-034-5: this is the only failure in the design where the user loses work
    // rather than the fill being incomplete, which is why it is a rule.
    expect(value('notes')).toBe('');
  });

  it('accounts for every control in a pass whose values never arrived', async () => {
    page(
      `<select name="country"><option value=""></option><option value="gb">GB</option></select>
       <select name="county"><option value=""></option></select>`,
      () => {
        field('country').addEventListener('change', () => {
          options(field('county') as HTMLSelectElement, ['devon']);
        });
      },
    );

    const real = background();
    let calls = 0;
    const source: ValueSource = (descriptors) =>
      // The background evicted between passes (UC-034 A12).
      ++calls === 1 ? real(descriptors) : Promise.resolve(undefined);

    const result = await fill(source);

    expect(result.capped).toBe('values-unavailable');
    // A control with no outcome vanishes from the count the user is shown, so
    // the fill would look smaller than it was rather than partly failed.
    expect(result.outcomes).toHaveLength(2);
    expect(statuses(result.outcomes)).toContain('failed');
  });

  it('settles a page that does not cascade without a second round of writes', async () => {
    page(`<input name="one"><input name="two">`);

    let batches = 0;
    const real = background();
    const result = await fill((descriptors) => {
      batches++;
      return real(descriptors);
    });

    // One pass to write, one to establish that the page is done. The second
    // makes no round trip, because nothing was left to describe — which is what
    // keeps the loop from costing an ordinary page anything but one wait.
    expect(batches).toBe(1);
    expect(result.passes).toBe(2);
    expect(result.capped).toBeUndefined();
  });
});

describe('nothing outlives the fill (NFR-035)', () => {
  const listeners = new Map<string, number>();
  let observers = 0;
  let connected = 0;
  const Original = globalThis.MutationObserver;

  beforeEach(() => {
    listeners.clear();
    observers = 0;
    connected = 0;

    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);

    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, capture) => {
      listeners.set(type, (listeners.get(type) ?? 0) + 1);
      add(type, listener, capture);
    });

    vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, capture) => {
      listeners.set(type, (listeners.get(type) ?? 0) - 1);
      remove(type, listener, capture);
    });

    globalThis.MutationObserver = class extends Original {
      constructor(callback: MutationCallback) {
        super(callback);
        observers++;
      }
      override observe(target: Node, init?: MutationObserverInit): void {
        connected++;
        super.observe(target, init);
      }
      override disconnect(): void {
        connected--;
        super.disconnect();
      }
    };
  });

  afterEach(() => {
    globalThis.MutationObserver = Original;
    vi.restoreAllMocks();
  });

  it('releases every listener and observer the fill installed', async () => {
    page(
      `<select name="country"><option value=""></option><option value="gb">GB</option></select>
       <select name="county"><option value=""></option></select>`,
      () => {
        field('country').addEventListener('change', () => {
          options(field('county') as HTMLSelectElement, ['devon']);
        });
      },
    );

    await fill();

    // The agent is on every page the user visits (DD-001), so anything left
    // running is paid for on all of them rather than on the filled one.
    expect(observers).toBeGreaterThan(0);
    expect(connected).toBe(0);
    expect([...listeners.values()].filter((count) => count !== 0)).toEqual([]);
  });
});

describe('the scheduler is a parameter, not a global', () => {
  it('takes every delay through the seam it was given', async () => {
    const calls: number[] = [];
    const scheduler: Scheduler = {
      setTimeout: (callback, ms) => {
        calls.push(ms);
        return realScheduler.setTimeout(callback, ms);
      },
      clearTimeout: realScheduler.clearTimeout,
      now: realScheduler.now,
    };

    page(`<input name="one">`);

    await runFill({
      root: document,
      settings: SETTINGS,
      writtenByUs: new WeakSet<Element>(),
      requestValues: background(),
      bounds: BOUNDS,
      scheduler,
    });

    // Without this the DD-009 fixture matrix could only ever run in the
    // end-to-end harness, where a failure is slow to reproduce and hard to
    // attribute (NFR-015).
    expect(calls).toContain(BOUNDS.quietMs);
    expect(calls).toContain(BOUNDS.maxQuietWaitMs);
  });
});

describe('what the loop carries through from a single pass', () => {
  it('answers a radio group once, however many members it has', async () => {
    page(`<form>
      <label><input type="radio" name="plan" value="a"> A</label>
      <label><input type="radio" name="plan" value="b"> B</label>
      <label><input type="radio" name="plan" value="c"> C</label>
    </form>`);

    const result = await fill();

    // Each member carries the whole group's options, so a per-element decision
    // makes them disagree — and since applying a choice means "tick me if I am
    // the chosen one", members choosing each other tick nothing at all.
    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(result.outcomes).toHaveLength(3);
  });

  it('keeps a group answered the same way when the page makes us write it again', async () => {
    let wiped = false;
    page(`<form>
      <label><input type="radio" name="plan" value="a"> A</label>
      <label><input type="radio" name="plan" value="b"> B</label>
    </form>`, () => {
      document.querySelector('form')!.addEventListener('change', () => {
        if (wiped) return;
        wiped = true;
        setTimeout(() => {
          for (const r of document.querySelectorAll<HTMLInputElement>('input')) r.checked = false;
        }, 5);
      });
    });

    await fill();

    // The group token is derived from its first member, which is stable across
    // passes — so the second write reaches the same conclusion as the first.
    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].filter((r) => r.checked);
    expect(checked).toHaveLength(1);
  });

  it('leaves a control whose identity matches an ignore pattern', async () => {
    page(`<input name="captcha_answer"><input name="email">`);

    const result = await fill(background(), BOUNDS, { ...SETTINGS, ignorePatterns: ['captcha'] });

    expect(value('captcha_answer')).toBe('');
    expect(value('email')).not.toBe('');
    expect(result.outcomes).toContainEqual({ ref: 0, status: 'skipped', reason: 'ignored-pattern' });
  });

  it('skips an unusable ignore pattern rather than abandoning the fill', async () => {
    page(`<input name="email">`);
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);

    try {
      const result = await fill(background(), BOUNDS, {
        ...SETTINGS,
        ignorePatterns: ['(unclosed', 'also[bad'],
      });
      expect(statuses(result.outcomes)).toEqual(['filled']);
    } finally {
      console.warn = original;
    }

    // Once per fill, not once per field — and not once per pass either, which is
    // the regression the loop could have introduced.
    expect(warnings).toHaveLength(1);
  });

  it('keeps filling after a control the page will not accept a value for (D10)', async () => {
    // The reference lets one uncaught exception abort the rest of the page, so a
    // single bad rule silently halves the form. Here the impossible value is
    // handed to a text input on purpose: `applyValue` throws, and the throw must
    // be that control's outcome and nothing else's.
    page(`<input name="first"><input name="second"><input name="third">`);

    const real = background();
    const result = await fill(async (descriptors) => {
      const values = await real(descriptors);
      return values?.map((value) =>
        value.ref === 1 ? { ref: 1, as: 'choice' as const, values: ['x'], provenance: 'impossible' } : value,
      );
    });

    expect(statuses(result.outcomes)).toEqual(['filled', 'failed', 'filled']);
    expect(value('first')).not.toBe('');
    expect(value('third')).not.toBe('');
  });
});
