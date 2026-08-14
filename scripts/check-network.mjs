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
 * **What this scan cannot prove.** It matches text, so it cannot see a call
 * assembled at runtime: `globalThis['fet' + 'ch']`, a name aliased through a
 * variable, or anything reached by property lookup on a computed string. The
 * common indirect forms are matched below, but no pattern list closes that class
 * — and neither would an AST walk, which would still lose the value of a
 * computed member expression.
 *
 * What actually closes it is upstream of here: the extension ships no runtime
 * dependency at all, `scripts/check-imports.mjs` fails the build on any package
 * entering the page agent that is not on an explicit allowlist, and NFR-007
 * forbids the remote-code constructs that would be needed to introduce one
 * later. This scan is the last line, not the only one, and reading it as
 * exhaustive would be a mistake.
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
 * Every API this build must not contain: the ones that can originate a request,
 * and the remote-code constructs NFR-007 forbids alongside them. Named for what
 * it forbids rather than for network alone, because a reader scanning for "which
 * network APIs are blocked" would otherwise miss that `eval` is in the list.
 *
 * Matched on word boundaries: a property named `fetchSettings` is not a network
 * call, and a gate that cries wolf on one gets switched off.
 */
const FORBIDDEN_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  // Indirect call forms. `(0, fetch)(url)` is what a bundler emits when it
  // preserves an indirect reference, and bracket access is the hand-written
  // equivalent. These do not make the scan exhaustive — see the note below — but
  // they cover the forms that arise in practice rather than only in theory.
  /\(\s*0\s*,\s*(?:fetch|eval)\s*\)/,
  /\[\s*["'](?:fetch|eval|XMLHttpRequest|WebSocket|EventSource|sendBeacon)["']\s*\]/,
  // NFR-007: no remote code. Listed here because the two failures arrive
  // together — remote code is fetched before it is run.
  /\bimportScripts\s*\(/,
  /\bnew\s+Function\s*\(/,
  // `eval` cannot originate a request by itself, so this is not a network hole.
  // It is here because NFR-007 names it explicitly and a stated policy that no
  // gate enforces is precisely the drift these gates exist to catch. It is also
  // an unconditional store-review failure: C-012 forbids obfuscated code, and
  // both stores treat `eval` in a bundle as exactly that.
  /\beval\s*\(/,
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

/**
 * The API scan applies to code, not to data.
 *
 * Shipped JSON is the i18n catalog and the manifest: a description or a message
 * string that happens to contain "fetch(" is text, not a call, and a gate that
 * fails on a translator's wording gets switched off. Same reasoning that keeps
 * the URL scan out of JavaScript, applied the other way round.
 */
function scansForApis(file) {
  return extname(file) !== '.json';
}

/**
 * The URL scan applies to markup, styles and the manifest — not to JavaScript.
 *
 * That is NFR-033's own scoping, and it is right. In HTML or CSS a URL *is* a
 * request: `<img src>`, `@font-face`, a stylesheet link all fetch on sight, so
 * finding one there is finding a network dependency. In JavaScript a URL is a
 * string, and a string cannot fetch itself — the API scan above is what decides
 * whether anything could request it.
 *
 * Scanning JS as well sounds stricter and is merely wrong: the extension
 * generates a website address for `autocomplete="url"` fields, so a URL literal
 * in the bundle is the product working, not a leak. A gate that fails on correct
 * behaviour gets switched off, and then it protects nothing.
 */
function scansForUrls(file) {
  const extension = extname(file);
  return extension === '.html' || extension === '.css' || file.endsWith('manifest.json');
}

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

    if (scansForApis(file)) {
      for (const api of FORBIDDEN_APIS) {
        const match = api.exec(source);
        if (match !== null) {
          violations.push(`${shown}: reachable network/remote-code API \`${match[0].trim()}\` (NFR-033, NFR-007)`);
        }
      }
    }

    if (!scansForUrls(file)) continue;

    for (const match of source.matchAll(URL_PATTERN)) {
      const url = match[0];
      if (ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) continue;
      violations.push(`${shown}: external URL \`${url}\` in shipped markup (NFR-006, G3)`);
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
