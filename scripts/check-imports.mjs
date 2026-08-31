#!/usr/bin/env node
/**
 * ND-4: nobody decided to ship Firebase into every page — an import graph decided
 * it. `element-filler` imported `helpers` for two small functions, `helpers` line
 * 1 imported `firebase`, and the reference's shipped content script became 480 KB
 * with an auth and database SDK inside it, in every frame of every page.
 *
 * This gate walks the page agent's *source* import graph and fails on anything
 * not explicitly permitted there. It runs on source rather than on the bundle
 * because the bundle only tells you how big the mistake was; the graph tells you
 * which edge made it. The size gate (NFR-003) catches the symptom, this catches
 * the cause, and the cause is the one that arrives silently.
 *
 * Three rules:
 *   1. Bare specifiers must be on ALLOWED_PACKAGES. A new dependency in the page
 *      agent is a deliberate act, never an inherited one.
 *   2. Local imports are denied by default: the agent may reach `src/lib/page/`
 *      and `src/lib/protocol.ts` and nothing else. A denylist of background
 *      areas was tried first and rotted silently — a refactor renamed
 *      `lib/matcher/` to `lib/rules/` and the gate kept passing while enforcing
 *      nothing. Default-deny cannot rot that way: any new `src/lib` module is
 *      background-only until someone argues it onto this list.
 *   3. Every area on the list must match at least one file on disk, so a typo or
 *      a future rename fails the gate loudly instead of narrowing it quietly.
 *
 * Usage: node scripts/check-imports.mjs
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/entrypoints/page-agent.content.ts');

/**
 * Bare specifiers the page agent may import. Everything WXT needs to define a
 * content script and talk to the extension API — and nothing that carries data.
 */
const ALLOWED_PACKAGES = new Set([
  'wxt/utils/define-content-script',
  'wxt/utils/content-script-context',
  'wxt/browser',
]);

/**
 * The only local areas the page agent may import. Everything else under `src/`
 * is background-only by default: the corpus, the generators, the persona
 * synthesiser, the rules and the settings all stay behind the background
 * boundary (DD-003); the agent walks and applies, and carries no data.
 *
 * An entry is either a directory (trailing separator) or a single file. The
 * separator keeps the prefix match from catching a sibling: without it,
 * `src/lib/protocol` also matches `src/lib/protocol-helpers.ts`, and a
 * perfectly legitimate import would be refused with a message about an area it
 * is not in. A gate that blocks correct code for a reason the reader cannot
 * reproduce is worse than one that misses something.
 */
const AGENT_AREAS = ['src/lib/page/', 'src/lib/protocol.ts'];

/** Every .ts file under src/, for the staleness self-check below. */
function allSourceFiles() {
  /** @param {string} dir */
  function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(path));
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
    return out;
  }
  return walk(join(ROOT, 'src')).map((path) => relative(ROOT, path).split(sep).join('/'));
}

// Rule 3: an area that matches nothing on disk means the list has gone stale —
// a typo in it today, a rename tomorrow — and the gate would be narrower than
// it looks without telling anyone. Fail loudly instead.
const sourceFiles = allSourceFiles();
for (const area of AGENT_AREAS) {
  const matches = sourceFiles.some(
    (file) => file === area || file.startsWith(area.endsWith('/') ? area : `${area}/`),
  );
  if (!matches) {
    console.error(
      `✖ AGENT_AREAS entry '${area}' matches no file under src/.\n` +
        `    The list has gone stale (typo or rename) — update scripts/check-imports.mjs.`,
    );
    process.exit(1);
  }
}

/**
 * Extracts static and dynamic import specifiers.
 *
 * Regex rather than a parser, and that is a real limitation: a dynamic import
 * with a computed specifier is invisible here. It is also forbidden — NFR-007
 * rules out `eval`, `new Function` and remotely fetched code, so every specifier
 * that can legally exist in this codebase is a literal.
 */
function importsOf(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Resolves a relative or aliased specifier to a file on disk, or null. */
function resolveLocal(specifier, importer) {
  let base;
  if (specifier.startsWith('@/')) {
    base = join(ROOT, 'src', specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(importer), specifier);
  } else {
    return null;
  }

  // A specifier that resolves to nothing is treated as a bare package name and
  // fails the allowlist, so an incomplete candidate list produces a confusing
  // failure about a "package" that is actually a local barrel.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const violations = [];
const visited = new Set();
const queue = [ENTRY];

while (queue.length > 0) {
  const file = queue.pop();
  if (visited.has(file)) continue;
  visited.add(file);

  const source = readFileSync(file, 'utf8');
  const importer = relative(ROOT, file);

  for (const specifier of importsOf(source)) {
    const resolved = resolveLocal(specifier, file);

    if (resolved === null) {
      if (!ALLOWED_PACKAGES.has(specifier)) {
        violations.push(
          `${importer} imports '${specifier}', which is not on the page agent's allowlist.\n` +
            `    A new package in the page agent is a deliberate decision (ND-4, NFR-003).\n` +
            `    If it belongs here, add it to ALLOWED_PACKAGES in scripts/check-imports.mjs.`,
        );
      }
      continue;
    }

    // Separators normalised to POSIX before comparing. `relative()` yields
    // backslashes on Windows, so a raw `startsWith('src/lib/page/')` would stop
    // matching there — and this gate failing open is worse than it failing
    // loudly, because nothing would announce that the rule had switched itself
    // off.
    const relativePath = relative(ROOT, resolved).split(sep).join('/');
    const allowed = AGENT_AREAS.some(
      (area) => relativePath === area || relativePath.startsWith(area.endsWith('/') ? area : `${area}/`),
    );
    if (!allowed) {
      violations.push(
        `${importer} imports '${specifier}' → ${relativePath}.\n` +
          `    That is outside the page agent's areas (src/lib/page/, src/lib/protocol.ts).\n` +
          `    Generation runs in the background (DD-003); if this module genuinely belongs\n` +
          `    in the agent, argue it onto AGENT_AREAS in scripts/check-imports.mjs.`,
      );
      continue;
    }

    queue.push(resolved);
  }
}

if (violations.length > 0) {
  console.error(`✖ page agent import graph: ${violations.length} violation(s)\n`);
  for (const violation of violations) console.error(`  ${violation}\n`);
  process.exit(1);
}

console.log(
  `✔ page agent import graph clean — ${visited.size} source file(s), ` +
    `no unlisted package, nothing reaching a background-only area`,
);
