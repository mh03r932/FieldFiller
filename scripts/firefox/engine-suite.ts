import { runFill } from '@/lib/page/fill-loop';
import { generateBatch } from '@/lib/generators/batch';
import { createPersona, seededRandom } from '@/lib/persona/persona';
import { agentSettings, DEFAULT_SETTINGS } from '@/lib/settings';
import type { FieldOutcome } from '@/lib/protocol';

/**
 * The fill engine, run against a real page in a real browser engine.
 *
 * **This is NFR-014's second sentence**, the one the unit suite could not
 * satisfy: "engine unit tests run identically against both targets on every
 * change". They did not — they ran once, under happy-dom, and happy-dom is
 * neither of the engines we ship to. NFR-015 is what makes closing that cheap:
 * the fill engine takes a `Document` and a callback and touches no extension
 * API, so the same code that runs inside the page agent runs here inside an
 * ordinary page with no extension installed at all.
 *
 * What that buys is the half of the engine where the two browsers genuinely
 * differ and a mock cannot tell you: `element.labels` resolving implicit labels,
 * the prototype value setter frameworks patch, `InputEvent` being a distinct
 * type from `Event`, shadow roots, `checkValidity`, and how each engine orders
 * the events a real user's typing produces. A pure-logic defect fails in
 * `vitest` already; a Gecko-versus-Blink defect had nowhere to fail before this.
 *
 * `requestValues` is where the background would sit. It calls the real
 * generators locally instead, so the pipeline under test is walk → identify →
 * exclude → generate → apply → verify — everything but the messaging, which is
 * what `smoke-firefox.mjs` covers and what needs an installed extension.
 */

type Result = {
  readonly outcomes: readonly FieldOutcome[];
  readonly passes: number;
  readonly capped?: string;
  /** What actually landed in the DOM, by control name, for the assertions. */
  readonly values: Record<string, string>;
  /** Every control the walk found, by kind, so a missing kind is visible. */
  readonly kinds: Record<string, number>;
};

declare global {
  interface Window {
    __fieldfillerRun?: () => Promise<Result>;
  }
}

window.__fieldfillerRun = async (): Promise<Result> => {
  const seed = 20260817;
  const random = seededRandom(seed);
  const persona = createPersona(random, 'en-US', DEFAULT_SETTINGS.passwords);
  const kinds: Record<string, number> = {};

  const result = await runFill({
    root: document,
    settings: agentSettings(DEFAULT_SETTINGS),
    writtenByUs: new WeakSet<Element>(),
    requestValues: (descriptors) => {
      for (const descriptor of descriptors) {
        kinds[descriptor.kind] = (kinds[descriptor.kind] ?? 0) + 1;
      }
      const { values } = generateBatch(descriptors, {
        persona,
        randomFor: () => random,
      });
      return Promise.resolve(values);
    },
  });

  // Read back through the DOM rather than from the outcomes, because the
  // question this harness exists to answer is whether the *write* worked in this
  // engine — an outcome says what we believed, and the DOM says what happened.
  const values: Record<string, string> = {};
  for (const element of document.querySelectorAll('[name]')) {
    const named = element as HTMLInputElement;
    if (typeof named.value === 'string' && named.name !== '') values[named.name] = named.value;
  }

  return {
    outcomes: result.outcomes,
    passes: result.passes,
    ...(result.capped === undefined ? {} : { capped: result.capped }),
    values,
    kinds,
  };
};
