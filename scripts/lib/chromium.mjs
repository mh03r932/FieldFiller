/**
 * The scaffolding every Chromium harness needs before it can test anything:
 * find a browser, predict the id it will give the unpacked extension, open a
 * debugging port, and speak CDP over it.
 *
 * Extracted 2026-08-17, after the same ~150 lines had been copied into seven
 * scripts. The duplication was not free — it drifted. The locale harness shipped
 * with the scopes harness's header comment describing the wrong use cases and
 * naming the wrong command, because the copy carried the prose with it; and a
 * missing watchdog in `connect` was re-propagated into every copy, so a browser
 * that died mid-run hung each of them until CI's own job timeout rather than
 * failing with a sentence saying what happened. A fix to one copy fixed one
 * copy. This module is the place a fix now lands once.
 *
 * Deliberately not a test framework. Each harness keeps its own launch
 * arguments, its own fixture, its own checks and its own reporting — those are
 * what the harnesses are *for*, and they differ on purpose. What is here is only
 * the part where they were identical.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * Playwright's pinned Chromium, if it has been downloaded.
 *
 * Used as a browser *locator* only — the driving is still plain CDP. It is
 * preferred over whatever Chrome the machine happens to have so that a local run
 * and a CI run exercise the same build: "works on my machine" is otherwise a
 * statement about an unpinned browser.
 */
function playwrightChromium() {
  try {
    const require = createRequire(import.meta.url);
    const path = require('playwright').chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    // Not installed. The candidate list still applies.
    return undefined;
  }
}

/**
 * The browser to drive.
 *
 * `CHROME_PATH` first, which is how CI pins one binary for every harness in the
 * job (see `.gitea/workflows/ci.yml`). Playwright's download second, because a
 * developer who ran `pnpm install` already has one. The installed browsers last.
 */
export function findChrome() {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const pinned = playwrightChromium();
  if (pinned !== undefined) return pinned;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      'No Chrome or Chromium found. Run `pnpm exec playwright install chromium`, or set CHROME_PATH.',
    );
  }
  return found;
}

/**
 * The id Chromium will give an unpacked extension loaded from this path.
 *
 * Chrome derives it from the absolute path: the first 32 hex digits of its
 * SHA-256, with 0–f mapped onto a–p. Knowing the id up front is what lets a
 * harness pick our service worker out of the target list — Chrome loads its own
 * component extensions regardless of `--disable-extensions-except`, and two of
 * them also have a `background.js`.
 */
export function derivedExtensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCodePoint(97 + Number.parseInt(digit, 16))).join('');
}

/**
 * A free port, picked per run rather than fixed — a browser that outlived a
 * previous run would otherwise be found on a fixed port and quietly tested in
 * place of the build on disk.
 */
export async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * How long any one CDP command may go unanswered before the harness gives up.
 *
 * Generous against a slow command and far under any CI job timeout, which is the
 * point: the harness must be the thing that reports the failure, in a sentence
 * naming the command that hung, rather than the job being killed twenty minutes
 * later with nothing to read.
 */
const CDP_TIMEOUT_MS = 30_000;

/**
 * What a page or worker threw, as a sentence.
 *
 * `Runtime.evaluate` reports a thrown expression — or, under `awaitPromise`, a
 * rejected promise — in `exceptionDetails`, and answers *successfully* while
 * doing it: the command worked, the code inside it did not. A caller reading
 * `result.value` therefore gets `undefined` and carries on, so the harness fails
 * later and somewhere else, naming the wrong thing. Every one of these is
 * surfaced at the `send` that caused it instead.
 *
 * `description` carries the message and stack where there is one; `text` is
 * usually just "Uncaught", so it is the fallback rather than the answer.
 */
function describeException(details) {
  return details.exception?.description ?? details.text ?? 'threw, with no detail given';
}

/**
 * A minimal CDP client with flat session support.
 *
 * Sessions are needed because service-worker targets are only reachable through
 * the browser-level endpoint — `/json/list` reports pages and never workers,
 * which is quietly misleading if you use it to decide whether an extension
 * loaded.
 *
 * Two further things here that a bare promise-per-command does not give, and
 * whose absence is invisible until the browser misbehaves:
 *
 * A **watchdog** per command. Without it a `send` whose reply never comes waits
 * forever, and "forever" in CI means the job timeout — a red build with no
 * message, pointing at no step.
 *
 * A **close path**. A browser that crashes mid-run takes the socket with it, and
 * every command already in flight would otherwise hang exactly as above. They
 * are rejected instead, with the crash named, so the failure the harness reports
 * is the one that happened.
 */
export async function connect(url, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const socket = new WebSocket(url);
  const pending = new Map();
  /** Frames carrying no `id` — CDP events, which some harnesses assert against. */
  const events = [];
  let nextId = 1;
  /** Set once the socket is gone, so later sends fail immediately and say why. */
  let gone;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`CDP connection failed: ${url}`)), {
      once: true,
    });
  });

  const abandon = (reason) => {
    gone ??= reason;
    for (const entry of pending.values()) entry.reject(gone);
    pending.clear();
  };

  // Both paths, and the same sentence: an abrupt end fires `error` then `close`,
  // an orderly one fires `close` alone, and which arrived first is not a fact
  // worth reporting differently. `abandon` keeps whichever came first.
  const dropped = () =>
    abandon(new Error('the CDP connection dropped — the browser most likely crashed or was killed'));
  socket.addEventListener('close', dropped);
  socket.addEventListener('error', dropped);

  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id === undefined) {
      events.push(frame);
      return;
    }
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    entry?.settle(frame);
  });

  return {
    events,
    send(method, params = {}, sessionId) {
      if (gone !== undefined) return Promise.reject(gone);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no reply in ${timeoutMs} ms — the browser stopped answering`));
        }, timeoutMs);
        pending.set(id, {
          settle: (frame) => {
            clearTimeout(watchdog);
            if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
            else if (frame.result?.exceptionDetails !== undefined) {
              reject(new Error(`${method}: ${describeException(frame.result.exceptionDetails)}`));
            } else resolve(frame.result);
          },
          reject: (error) => {
            clearTimeout(watchdog);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async attach(targetId) {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      return sessionId;
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Starts Chromium with the extension loaded, and waits for its debugging
 * endpoint to answer.
 *
 * The flags are the ones every harness passed identically. `extensionDir` is
 * optional: a spike measuring page behaviour rather than the extension passes
 * nothing and gets a plain browser.
 *
 * Nothing survives a failure here. The caller's handle comes from destructuring
 * what this returns, so a throw leaves its `chrome` unassigned and its
 * `finally { chrome?.kill() }` a no-op — and the browser, if it did start,
 * outlives the run holding the temp profile open, which is what makes the next
 * run's `rmSync` fail too. The inline code this replaced assigned the caller's
 * variable before it could fail; owning the cleanup here restores that property
 * rather than asking every harness to remember it.
 */
export async function launchChromium(extensionDir, profileDir) {
  const debugPort = await freePort();
  const chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      ...(extensionDir === undefined
        ? []
        : [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`]),
      // Extensions require the *new* headless mode; the old one ignored them.
      ...(process.env['HEADFUL'] === '1' ? [] : ['--headless=new']),
      // CI containers run as root, where Chrome's sandbox refuses to start, and
      // their /dev/shm is typically too small for the renderer. Applied only
      // when CI is set, so a developer's machine keeps the sandbox it should
      // have.
      ...(process.env['CI'] === undefined ? [] : ['--no-sandbox', '--disable-dev-shm-usage']),
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    let wsUrl;
    for (let attempt = 0; attempt < 100 && wsUrl === undefined; attempt++) {
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json())
          .webSocketDebuggerUrl;
      } catch {
        await sleep(150);
      }
    }
    if (wsUrl === undefined) {
      throw new Error(`Chromium never opened a debugging endpoint on port ${debugPort}`);
    }
    return { chrome, cdp: await connect(wsUrl) };
  } catch (error) {
    // Covers both failure points: an endpoint that never opened, and a socket
    // that refused the connection after it did. Waited out rather than fired and
    // forgotten — `kill` returns while Chrome is still flushing its profile, and
    // the caller's own cleanup cannot cover the gap here because its `chrome` is
    // the variable this failed destructuring never assigned.
    await stopBrowser(chrome);
    throw error;
  }
}

/**
 * Stops a browser and waits for it to actually be gone.
 *
 * `kill` returns immediately; the process is still flushing its profile
 * directory afterwards, so removing that directory straight away races the
 * flush. Everything that ends a browser goes through here so the wait cannot be
 * forgotten in one path and remembered in another — which is exactly what had
 * happened between the launch failure path and the teardown.
 */
async function stopBrowser(chrome) {
  if (chrome === undefined) return;
  chrome.kill();
  const exited = await Promise.race([
    new Promise((resolve) => chrome.once('exit', () => resolve(true))),
    sleep(5000).then(() => false),
  ]);
  // A browser that ignored SIGTERM would otherwise outlive the run holding the
  // profile open, which is the orphan this whole path exists to prevent.
  if (!exited) chrome.kill('SIGKILL');
}

/**
 * The extension's background service worker, once Chromium has started it.
 *
 * Polled rather than awaited on an event: the worker is started by the browser
 * on its own schedule after the extension loads, and there is no CDP signal that
 * means "the extension is ready".
 */
export async function attachToWorker(cdp, extensionId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
    );
    if (worker !== undefined) {
      const session = await cdp.attach(worker.targetId);
      await waitForBindings(cdp, session);
      return session;
    }
    await sleep(100);
  }
  throw new Error('the background service worker never started');
}

/**
 * Waits for the extension APIs to appear in a worker we have just attached to.
 *
 * A worker target becomes attachable *before* its `chrome.*` bindings are
 * installed, and the gap is about 20 ms. Measured on Chrome for Testing 151,
 * polling a freshly attached session every 10 ms:
 *
 *   +22 ms  { chrome: 'object', id: null, storage: 'undefined', tabs: 'undefined' }
 *   +40 ms  { chrome: 'object', id: 'inkceiio…', storage: 'object', tabs: 'object' }
 *
 * So `chrome` is already an object while everything on it is still missing —
 * which is why the symptom is a `TypeError` reading a property of `undefined`
 * rather than an obvious "no API here".
 *
 * The gate is `runtime.id` rather than any one API, because the bindings arrive
 * together and `runtime` is the only one every caller has regardless of which
 * permissions the manifest asked for.
 *
 * Whether the gap is *hit* depends on how soon the first evaluation follows the
 * attach: a harness that sleeps before attaching finds a warm worker and never
 * sees it. `e2e-locale.mjs` attaches immediately after launch and did see it —
 * on CI, where startup is slower, and never on a developer's machine.
 */
async function waitForBindings(cdp, session) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression: 'chrome?.runtime?.id ?? null', returnByValue: true },
      session,
    );
    if (result.value !== null && result.value !== undefined) return;
    await sleep(20);
  }
  throw new Error('the service worker attached but its extension APIs never appeared');
}

/**
 * Waits until the page agent is listening in the tab about to be filled.
 *
 * Readiness as a condition, not a sleep. A fixed wait before the trigger is the
 * thinnest margin any of these harnesses has: ample on an idle machine, and on a
 * loaded shared runner short enough that the fill is triggered into a page whose
 * agent has not registered yet. That fails as "the fill did not run" — correctly
 * diagnosed by the engine, and a flake all the same, whose stated reason is a
 * clock rather than the code under test.
 *
 * The protocol's own ping is the exact condition a sleep approximates. A `pong`
 * means the agent is injected and listening; until it is, `sendMessage` rejects
 * with "receiving end does not exist" and the poll retries. `readyState` would
 * not do: the agent registers at `document_idle`, which Chrome may place
 * *after* the load event.
 *
 * The tab is left to the caller to identify, because the harnesses legitimately
 * differ on that — one navigates the only tab and relies on it, another looks
 * for the active one — and pinging a tab the fill will not target proves
 * nothing.
 */
export async function waitForAgent(cdp, workerSession, tabExpression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pinged = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `chrome.tabs.query({}).then((tabs) => {
          const tab = ${tabExpression};
          if (tab === undefined) return 'no tab among ' + tabs.length;
          return chrome.tabs.sendMessage(tab.id, { kind: 'ping' })
            .then((reply) => reply !== undefined && reply.kind === 'pong'
              ? 'pong'
              : 'answered without a pong: ' + JSON.stringify(reply))
            .catch(() => 'not listening yet');
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    );
    if (pinged.result.value === 'pong') return;
    await sleep(100);
  }
  throw new Error('the page agent never answered a ping within 10 s of navigation');
}

/**
 * Ends a run: close the connection, stop the browser, remove the profile.
 *
 * Owned here because the alternative was six copies that had already diverged
 * into two variants — four waiting for the process to exit before touching the
 * directory, and two that killed and slept 200 ms. Chrome is still flushing its
 * profile when `kill` returns, so the short variant races the flush on a slow
 * disk and leaves a temp directory behind. The `rmSync` retries usually cover
 * it; "usually" is the reason to have one version rather than the reason not to.
 *
 * Everything here is best effort. A harness has produced its result by the time
 * this runs, and a failure to tidy up is not one of that result's outcomes.
 */
export async function closeChromium({ chrome, cdp, profileDir }) {
  try {
    cdp?.close();
  } catch {
    // Already gone with the browser.
  }

  await stopBrowser(chrome);

  if (profileDir === undefined) return;
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`  (left a temp profile behind: ${profileDir})`);
  }
}

/**
 * A click the browser counts as a real user gesture.
 *
 * `element.click()` is enough for most of what these harnesses do, and it is
 * what most of them use. It is not enough where a download is involved:
 * Chromium allows one download from a page that has seen no user interaction
 * and silently blocks the rest, so a second export wrote no file at all and
 * read as the feature being broken rather than as the harness being too clever.
 * Dispatching the press and the release puts the gesture where the browser
 * looks for it — which is also what a person does.
 *
 * Owned here rather than in one harness because the export and import harnesses
 * both need it, and a second copy of a workaround is how the *reason* for the
 * workaround gets lost.
 */
export async function clickWithGesture(cdp, session, selector) {
  const { result } = await cdp.send(
    'Runtime.evaluate',
    {
      expression:
        '(() => {' +
          `const element = document.querySelector(${JSON.stringify(selector)});` +
          'if (element === null) return null;' +
          "element.scrollIntoView({ block: 'center' });" +
          'const box = element.getBoundingClientRect();' +
          'return { x: box.left + box.width / 2, y: box.top + box.height / 2 };' +
        '})()',
      returnByValue: true,
    },
    session,
  );

  const at = result.value;
  if (at === null || at === undefined) throw new Error(`nothing to click for \`${selector}\``);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type, x: at.x, y: at.y, button: 'left', clickCount: 1 },
      session,
    );
  }
}

/**
 * A settings state as a string that depends on its content and not on its order.
 *
 * `chrome.storage.local` hands an object back with its keys in **alphabetical**
 * order, at every level, rather than the order they were written in — measured
 * when a harness assertion that nothing had touched storage failed against a
 * state nothing had touched. Any harness comparing a stored state against the
 * one it seeded needs this, and comparing `JSON.stringify` of the two is the
 * trap it exists to keep people out of.
 *
 * It is also the shortest statement of why `lib/settings-file.ts` restates the
 * schema's key order itself: every configuration the extension exports has been
 * through this round trip.
 */
export function canonicalState(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalState).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${canonicalState(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

