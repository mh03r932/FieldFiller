/**
 * Development tracing for the background context.
 *
 * Unconditional `console.debug`, not gated on `serve`: a background worker
 * has no user-visible surface, and its console is read only by someone who
 * opened the service-worker inspector — so the cost of always logging is
 * nothing, while the cost of a `serve`-only gate was that every failure path
 * a real user hit (a fill that never started, a frame that never reported)
 * was invisible outside development. A `debug` level rather than `warn`
 * because nothing here asks anyone to act; it is the record of what the
 * background decided.
 *
 * The page agent has no equivalent and must not grow one: a console line in
 * the content script prints into the user's page console (NFR-007's spirit,
 * and the page's console is not ours to write in).
 */
export function trace(text: string): void {
  console.debug(`[fieldfiller] ${text}`);
}
