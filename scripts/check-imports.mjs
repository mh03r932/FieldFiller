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
 * Two rules:
 *   1. Bare specifiers must be on ALLOWED_PACKAGES. A new dependency in the page
 *      agent is a deliberate act, never an inherited one.
 *   2. No import may reach a background-only area — the corpus, the generators,
 *      the persona synthesiser or the matcher. Generation runs in the background
 *      (DD-003); the agent walks and applies, and carries no data.
 *
 * Usage: node scripts/check-imports.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
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
 * Source areas that belong to the background context only. Most do not exist
 * yet; they are listed now so the rule is in force the moment they do, rather
 * than being written after the first violation has already shipped.
 */
const BACKGROUND_ONLY = [
  'src/lib/corpus',
  'src/lib/generators',
  'src/lib/persona',
  'src/lib/matcher',
];

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

  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
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
    // backslashes on Windows, so a raw `startsWith('src/lib/generators')` would
    // stop matching there — and this gate failing open is worse than it failing
    // loudly, because nothing would announce that the rule had switched itself
    // off.
    const relativePath = relative(ROOT, resolved).split(sep).join('/');
    const forbidden = BACKGROUND_ONLY.find((area) => relativePath.startsWith(area));
    if (forbidden !== undefined) {
      violations.push(
        `${importer} imports '${specifier}' → ${relativePath}.\n` +
          `    ${forbidden}/ is background-only: generation does not run in the page (DD-003).`,
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
