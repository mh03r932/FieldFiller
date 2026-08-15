/**
 * The two things the fixpoint loop watches: when the page stops changing, and
 * whether the user has started working in it (DD-009, UC-034).
 *
 * Kept apart from the loop itself because both are *timing*, and NFR-015
 * requires the engine to be testable without a browser. The scheduler is a
 * parameter for the same reason the walk takes its root: otherwise the whole
 * DD-009 fixture matrix could only ever run in the end-to-end harness, where a
 * failure is slow to reproduce and hard to attribute.
 */

/**
 * The clock and the timer, injected.
 *
 * Deliberately not `AbortSignal`-shaped or promise-shaped: a test needs to make
 * time pass without waiting for it, and that is only possible if every delay in
 * the loop goes through one seam.
 */
export type Scheduler = {
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
  readonly now: () => number;
};

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  now: () => Date.now(),
};

/**
 * The attributes worth waking up for.
 *
 * A narrow filter rather than every attribute: these are the ones that decide
 * whether a control is *available* — which is most of P2 — and watching all
 * attributes on a subtree means a callback on every class toggle an animation
 * makes. `style` and `class` are here because that is how `display:none` is
 * usually lifted, and `aria-busy` because a component that sets it is telling
 * us, in the page's own vocabulary, that it has not finished.
 */
const ATTRIBUTE_FILTER = [
  'disabled',
  'hidden',
  'readonly',
  'style',
  'class',
  'aria-disabled',
  'aria-busy',
];

export type QuiescenceBounds = {
  /** How long without a mutation counts as quiet. */
  readonly quietMs: number;
  /** How long to wait for quiet before giving up on it (UC-034 A8). */
  readonly maxMs: number;
};

/**
 * Waits until the frame stops changing, or until the wait is spent.
 *
 * This decides **when to look**, and nothing else (BR-034-8). What actually
 * changed is read from the DOM afterwards, because the most important case in
 * the whole decision — a framework reverting our write with a property
 * assignment — produces no mutation record at all. A loop that took its diff
 * from the records would be blind to precisely the failure it was built to
 * catch, and would then report those controls as filled.
 *
 * `'still-changing'` is not an error. An animation, a carousel or a polling
 * widget can keep a page busy forever, and none of them is distinguishable from
 * a slow cascade without knowing more about the page than we do — so the wait is
 * capped and the sweep runs anyway (UC-034 A8).
 */
export function waitForQuiescence(
  root: Document,
  bounds: QuiescenceBounds,
  scheduler: Scheduler,
): Promise<'quiet' | 'still-changing'> {
  return new Promise((resolve) => {
    // Every timer this wait owns, so that settling can drop all of them without
    // any one of them having to be named — the deadline and the quiet timer are
    // mutually recursive with `settle`, and tracking them individually means
    // declaring them before they can be created.
    const timers = new Set<number>();
    let quiet: number | undefined;
    let done = false;

    const after = (ms: number, callback: () => void): number => {
      const handle = scheduler.setTimeout(callback, ms);
      timers.add(handle);
      return handle;
    };

    const settle = (outcome: 'quiet' | 'still-changing'): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      for (const handle of timers) scheduler.clearTimeout(handle);
      timers.clear();
      resolve(outcome);
    };

    const restart = (): void => {
      if (quiet !== undefined) {
        scheduler.clearTimeout(quiet);
        timers.delete(quiet);
      }
      quiet = after(bounds.quietMs, () => settle('quiet'));
    };

    // The records themselves are never read. Their arrival is the whole signal,
    // which is why this callback takes no parameter.
    const observer = new MutationObserver(() => restart());

    after(bounds.maxMs, () => settle('still-changing'));
    restart();

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRIBUTE_FILTER,
    });
  });
}

/**
 * Watches for the user working in the page while a fill is running (FR-079).
 *
 * A cascade stretches a fill from milliseconds to seconds, which is long enough
 * for a human to start typing into it. This is the only failure in DD-009 where
 * the *user* loses work rather than the fill being incomplete, so it is a rule
 * and not a mitigation (BR-034-5).
 *
 * The discrimination is exact and costs nothing: every event this extension
 * dispatches — including the real `click()` a checkbox receives — carries
 * `isTrusted: false`, because only the platform can set it true. Nothing here
 * depends on timing, ordering, or a flag we have to remember to set.
 *
 * None of the three trigger channels delivers its own event into the page: the
 * browser consumes an extension command, and the toolbar button and the context
 * menu are chrome rather than content. So a trusted event arriving during a fill
 * is the user, not the trigger that started it.
 */
export type UserInputWatch = {
  /** Controls the user has touched since the fill began. Never written to. */
  readonly touched: WeakSet<Element>;
  /** Whether any trusted interaction has arrived, which ends the cascade. */
  readonly interrupted: () => boolean;
  /** Removes the listeners. Called from a `finally`, never optional (NFR-035). */
  readonly release: () => void;
};

export function watchUserInput(root: Document): UserInputWatch {
  const touched = new WeakSet<Element>();
  let interrupted = false;

  const noticed = (event: Event): void => {
    if (!event.isTrusted) return;
    interrupted = true;
    if (event.target instanceof Element) touched.add(event.target);
  };

  // Capture, so a page that stops propagation on its own handlers cannot also
  // stop us from noticing the user. Listening on the document rather than per
  // control is what makes this cost nothing on a 500-field page, and what lets
  // it cover controls that did not exist when the fill began.
  const types = ['input', 'keydown', 'pointerdown'];
  for (const type of types) root.addEventListener(type, noticed, true);

  return {
    touched,
    interrupted: () => interrupted,
    release: () => {
      for (const type of types) root.removeEventListener(type, noticed, true);
    },
  };
}
