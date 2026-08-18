/**
 * Launching Firefox and talking WebDriver BiDi to it.
 *
 * Extracted from `smoke-firefox.mjs` when a second Firefox harness arrived, on
 * the same reasoning as `lib/chromium.mjs`: two copies of a browser lifecycle
 * is how one of them comes to leak a process, and a survivor holds its profile
 * and its port — which is how one flaky run poisons the next.
 *
 * BiDi rather than `web-ext` or a driver binary: Firefox speaks it natively, and
 * release Firefox refuses to load an unsigned extension from a profile, so a
 * temporary install over the remote protocol is the only way to load a
 * development build at all.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIREFOX_CANDIDATES = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
];

export function findFirefox() {
  const fromEnv = process.env['FIREFOX_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const found = FIREFOX_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error('No Firefox found. Set FIREFOX_PATH to the executable.');
  }
  return found;
}

/**
 * A free port, picked per run rather than fixed.
 *
 * A fixed port is a trap here: if a previous run's Firefox outlived its `kill`,
 * the next run connects to *that* browser and fails with "maximum number of
 * active sessions" — a confusing error about the wrong process, testing a build
 * that is no longer on disk. With an ephemeral port a stale browser is simply
 * invisible, and a connection failure means what it says.
 */
export async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Minimal WebDriver BiDi client. */
export async function connectBidi(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`BiDi connection failed: ${url}`)));
  });

  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id === undefined) return;
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (frame) => {
          if (frame.type === 'error') {
            reject(new Error(`${method}: ${frame.error} — ${frame.message}`));
          } else {
            resolve(frame.result);
          }
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

/**
 * How much of the browser's own output to keep for an error message.
 *
 * A tail rather than the whole stream: Firefox is chatty on stderr — a headless
 * run prints GTK and dbus grumbling that means nothing — and the sentence that
 * explains a failed start is the last thing it says before it stops.
 */
const OUTPUT_TAIL = 4000;

/** The browser's last words, folded into an error message, if it said any. */
function quote(output) {
  const said = output().trim();
  return said === '' ? ' It printed nothing.' : `\n\n  Firefox said:\n${said.replace(/^/gm, '    ')}\n`;
}

/**
 * Waits for the remote agent, or explains why it never arrived.
 *
 * Two failures wear the same symptom — no port — and want different fixes, so
 * they are told apart here rather than both being reported as a timeout. A
 * browser that *exited* did so for a reason it already printed: a missing
 * shared library, typically, on a machine where Firefox's own dependencies were
 * never installed. Polling on regardless spends the whole timeout on a port
 * belonging to a process that has been dead since the first few hundred
 * milliseconds, and then reports the poll — which names the harness rather than
 * the browser, and leaves the actual sentence in a pipe nobody is reading.
 */
async function waitForBidi(port, { exited, output }, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gone = exited();
    if (gone !== undefined) {
      throw new Error(`Firefox exited before opening a BiDi port — ${gone}.${quote(output)}`);
    }
    try {
      return await connectBidi(`ws://127.0.0.1:${port}/session`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error(
    `Firefox did not open a BiDi port within ${timeoutMs}ms (it is still running).${quote(output)}`,
  );
}

/**
 * Starts Firefox with a throwaway profile and an open BiDi session.
 *
 * Its output is piped rather than discarded, and read as it arrives. `ignore`
 * was cheaper to write and is what hid the CI failure described above; piping
 * without draining would be worse still, since a browser that fills the pipe
 * buffer then blocks on a write nobody is reading, which looks exactly like a
 * slow start.
 *
 * Nothing survives a failure here, on the same reasoning as `launchChromium`:
 * the caller's handle comes from destructuring what this returns, so a throw
 * leaves its `session` undefined and its `closeFirefox(session ?? {})` a no-op —
 * leaking the temp profile, and the browser too if it got as far as running.
 */
export async function launchFirefox() {
  const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-ff-'));
  const debugPort = await freePort();

  const firefox = spawn(
    findFirefox(),
    [
      '--profile',
      profileDir,
      '--remote-debugging-port',
      String(debugPort),
      ...(process.env['HEADFUL'] === '1' ? [] : ['--headless']),
      '--no-remote',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  const keep = (chunk) => {
    output = (output + chunk).slice(-OUTPUT_TAIL);
  };
  firefox.stdout.setEncoding('utf8').on('data', keep);
  firefox.stderr.setEncoding('utf8').on('data', keep);

  // Why a variable rather than a promise raced against the poll: the poll has
  // to keep running after the browser is up, and a rejected promise nobody is
  // awaiting by then is an unhandled rejection. `error` covers a binary that
  // cannot be executed at all, which never reaches `exit`.
  let gone;
  firefox.once('error', (error) => (gone ??= `it could not be started (${error.message})`));
  firefox.once('exit', (code, signal) => (gone ??= `exit ${code ?? 'none'}, signal ${signal ?? 'none'}`));

  // Held outside the `try` so a failed `session.new` takes its socket down with
  // it: the connection is open by then, and the caller has no handle to close.
  let bidi;
  try {
    bidi = await waitForBidi(debugPort, { exited: () => gone, output: () => output });
    await bidi.send('session.new', { capabilities: { alwaysMatch: {} } });
    return { firefox, bidi, profileDir };
  } catch (error) {
    await closeFirefox({ firefox, bidi, profileDir });
    throw error;
  }
}

/**
 * Stops Firefox and removes its profile.
 *
 * Escalates to SIGKILL rather than trusting SIGTERM: Firefox does not reliably
 * exit on it while headless, and a survivor holds its profile and its port.
 *
 * A process that has *already* exited is skipped rather than waited for. Node
 * does not replay `exit` to a listener attached afterwards, so both escalation
 * waits ran to their full length on a browser that died on its own — eight
 * seconds of nothing, appended to the failure this path exists to report.
 */
export async function closeFirefox({ firefox, bidi, profileDir }) {
  bidi?.close();

  if (firefox !== undefined && firefox.exitCode === null && firefox.signalCode === null) {
    firefox.kill();
    const exited = await Promise.race([
      new Promise((resolve) => firefox.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited) {
      firefox.kill('SIGKILL');
      await Promise.race([new Promise((resolve) => firefox.once('exit', resolve)), sleep(3000)]);
    }
  }

  if (profileDir !== undefined) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.warn(`  (left a temp profile behind: ${profileDir})`);
    }
  }
}
