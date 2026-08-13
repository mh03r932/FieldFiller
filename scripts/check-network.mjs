#!/usr/bin/env node
/**
 * NFR-033: establish the absence of network capability by static analysis of the
 * built bundle — no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or
 * `sendBeacon` reachable in shipped code, and no external URL in any shipped
 * HTML, CSS, or the manifest.
 *
 * G3 is stated absolutely: "makes no outbound request, ever. Not telemetry, not
 * error reporting, not a font." An absolute claim needs a gate that runs on every
 * build, because the way it will actually break is a transitive dependency
 * bringing an SDK in — which is precisely how the reference ended up shipping
 * Firebase (ND-4).
 *
 * Static analysis is primary, and runtime traffic monitoring runs in addition,
 * never instead: a runtime check can only demonstrate the code paths it happened
 * to exercise, and it cannot observe requests originating in the background
 * context without browser-level instrumentation.
 *
 * Usage: node scripts/check-network.mjs   (after `pnpm run build:all`)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, '.output');
const TARGETS = ['chrome-mv3', 'firefox-mv3'];

/**
 * Every API that can originate a request. Matched on word boundaries: a property
 * named `fetchSettings` is not a network call, and a gate that cries wolf on it
 * gets switched off.
 */
const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  // NFR-007: no remote code. Listed here because the two failures arrive
  // together — remote code is fetched before it is run.
  /\bimportScripts\s*\(/,
  /\bnew\s+Function\s*\(/,
];

/**
 * Absolute URLs that may legitimately appear in shipped files. These are
 * identifiers, not fetch targets: XML namespaces are never requested, and a
 * licence URL in a comment is text.
 */
const ALLOWED_URL_PREFIXES = [
  'http://www.w3.org/', // XML/SVG namespaces
  'https://www.w3.org/',
  'http://www.mozilla.org/MPL/', // licence identifiers in dependency banners
  'https://opensource.org/licenses/',
];

const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.json']);
const URL_PATTERN = /\bhttps?:\/\/[^\s"'`)<>\\]+/g;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (SCANNED_EXTENSIONS.has(extname(entry))) files.push(full);
  }
  return files;
}

const violations = [];
let scannedFiles = 0;

for (const target of TARGETS) {
  const targetDir = join(OUTPUT_DIR, target);
  if (!existsSync(targetDir)) {
    console.error(`✖ ${target}: no build found. Run \`pnpm run build:all\` first.`);
    process.exit(1);
  }

  for (const file of walk(targetDir)) {
    const source = readFileSync(file, 'utf8');
    const shown = relative(OUTPUT_DIR, file);
    scannedFiles++;

    for (const api of NETWORK_APIS) {
      const match = api.exec(source);
      if (match !== null) {
        violations.push(`${shown}: reachable network/remote-code API \`${match[0].trim()}\` (NFR-033, NFR-007)`);
      }
    }

    for (const match of source.matchAll(URL_PATTERN)) {
      const url = match[0];
      if (ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) continue;
      violations.push(`${shown}: external URL \`${url}\` in a shipped file (NFR-006, G3)`);
    }
  }
}

if (violations.length > 0) {
  console.error(`✖ network absence: ${violations.length} violation(s)\n`);
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    '\n  G3 claims no outbound request is possible, not that none is made. ' +
      'A violation here makes the claim false.',
  );
  process.exit(1);
}

console.log(`✔ no network or remote-code capability in ${scannedFiles} shipped file(s) across both targets`);
