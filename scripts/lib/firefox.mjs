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

async function waitForBidi(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await connectBidi(`ws://127.0.0.1:${port}/session`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Firefox did not open a BiDi port in time');
}

/** Starts Firefox with a throwaway profile and an open BiDi session. */
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
    { stdio: 'ignore' },
  );

  const bidi = await waitForBidi(debugPort);
  await bidi.send('session.new', { capabilities: { alwaysMatch: {} } });
  return { firefox, bidi, profileDir };
}

/**
 * Stops Firefox and removes its profile.
 *
 * Escalates to SIGKILL rather than trusting SIGTERM: Firefox does not reliably
 * exit on it while headless, and a survivor holds its profile and its port.
 */
export async function closeFirefox({ firefox, bidi, profileDir }) {
  bidi?.close();

  if (firefox !== undefined) {
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
