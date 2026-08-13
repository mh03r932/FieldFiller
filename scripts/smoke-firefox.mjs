#!/usr/bin/env node
/**
 * Loads the built Firefox package in a real Firefox and asserts it installs.
 *
 * The Chromium smoke test's counterpart, and the more important of the two for
 * this project: C-003 (background model) and C-004 (`gecko.id`) exist precisely
 * because the two browsers disagree about the manifest, and a build that is
 * accepted by Chrome tells you nothing about Firefox. Installation is where a
 * rejected key surfaces.
 *
 * Driven over WebDriver BiDi, which Firefox speaks natively — no `web-ext`, no
 * driver binary. Release Firefox refuses to load an unsigned extension from a
 * profile, so a temporary install over the remote protocol is the only way to
 * load a development build at all.
 *
 * Usage: node scripts/smoke-firefox.mjs   (after `pnpm run build:firefox`)
 *   FIREFOX_PATH=…  override the browser binary
 *   HEADFUL=1       show the window, for debugging this script
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, '.output', 'firefox-mv3');

const FIREFOX_CANDIDATES = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A free port, picked per run rather than fixed.
 *
 * A fixed port is a trap here: if a previous run's Firefox outlived its `kill`,
 * the next run connects to *that* browser and fails with "maximum number of
 * active sessions" — a confusing error about the wrong process, testing a build
 * that is no longer on disk. With an ephemeral port a stale browser is simply
 * invisible, and a connection failure means what it says.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function findFirefox() {
  const fromEnv = process.env['FIREFOX_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const found = FIREFOX_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error('No Firefox found. Set FIREFOX_PATH to the executable.');
  }
  return found;
}

/** Minimal WebDriver BiDi client. */
async function connectBidi(url) {
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
          if (frame.type === 'error') reject(new Error(`${method}: ${frame.error} — ${frame.message}`));
          else resolve(frame.result);
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

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('✖ no Firefox build found. Run `pnpm run build:firefox` first.');
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), 'fieldfiller-smoke-ff-'));
const failures = [];
let firefox;
let bidi;

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>smoke</title><form><input name="email"></form>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  const debugPort = await freePort();
  firefox = spawn(
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

  bidi = await waitForBidi(debugPort);
  await bidi.send('session.new', { capabilities: { alwaysMatch: {} } });

  // The assertion that matters: Firefox accepts the manifest. A rejected
  // `gecko.id` (C-004), an MV3 background block it disagrees with (C-003), or an
  // unknown permission all fail right here.
  const installed = await bidi.send('webExtension.install', {
    extensionData: { type: 'path', path: EXTENSION_DIR },
  });
  console.log(`✔ installed as a temporary add-on (${installed.extension})`);

  if (installed.extension !== 'fieldfiller@dividbzero') {
    failures.push(
      `Firefox assigned id "${installed.extension}", not the gecko.id from the manifest (C-004)`,
    );
  } else {
    console.log('✔ gecko.id honoured — the AMO listing identity is stable (C-004)');
  }

  // A page load with the add-on installed. The page agent has no observable
  // effect by design, so this is a crash check rather than an injection check:
  // an agent that throws on startup takes the navigation's console with it.
  const context = await bidi.send('browsingContext.create', { type: 'tab' });
  await bidi.send('browsingContext.navigate', {
    context: context.context,
    url: pageUrl,
    wait: 'complete',
  });
  console.log(`✔ navigated to ${pageUrl} with the add-on installed`);

  const evaluated = await bidi.send('script.evaluate', {
    expression: 'document.querySelector("input[name=email]") !== null',
    target: { context: context.context },
    awaitPromise: false,
  });
  if (evaluated.result?.value !== true) {
    failures.push('the test page did not load as expected');
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  bidi?.close();
  server.close();

  if (firefox !== undefined) {
    firefox.kill();
    const exited = await Promise.race([
      new Promise((resolve) => firefox.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ]);
    // Firefox does not reliably exit on SIGTERM while headless, and a survivor
    // holds its profile and its port — which is how one flaky run poisons the
    // next. Escalate rather than leave it running.
    if (!exited) {
      firefox.kill('SIGKILL');
      await Promise.race([new Promise((resolve) => firefox.once('exit', resolve)), sleep(3000)]);
    }
  }

  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`  (left a temp profile behind: ${profileDir})`);
  }
}

if (failures.length > 0) {
  console.error('\n✖ Firefox smoke test failed:\n');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log('\n✔ the extension loads and runs in Firefox');
