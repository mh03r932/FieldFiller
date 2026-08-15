#!/usr/bin/env node
/**
 * NFR-008, enforced rather than reviewed.
 *
 * The permission list is the single most legible privacy claim an extension
 * makes: it is what a store listing shows, what an installer is asked to accept,
 * and the first thing an auditor reads. It is also the easiest thing to grow by
 * accident — a library that wants `tabs`, a feature that reaches for `cookies`,
 * a debugging session that adds `downloads` and never takes it away. None of
 * those announce themselves in a diff the way a new dependency does.
 *
 * So the manifest is checked against the requirement on every build, for both
 * targets, and a permission that is neither allowed nor known-forbidden fails
 * too — because the failure mode worth catching is the one nobody predicted.
 *
 * Usage: node scripts/check-permissions.mjs   (after `pnpm run build:all`)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { name: 'chrome-mv3', dir: join(ROOT, '.output', 'chrome-mv3') },
  { name: 'firefox-mv3', dir: join(ROOT, '.output', 'firefox-mv3') },
];

/** Exactly what NFR-008 permits, and nothing beside. */
const ALLOWED = new Set(['storage', 'contextMenus', 'scripting', 'activeTab']);

/**
 * Named in NFR-008 as the ones that must never appear.
 *
 * Listed separately from "not allowed" so the failure can say *why* this one
 * matters — each is a capability the extension has a plausible-sounding reason
 * to want and no actual need for.
 */
const FORBIDDEN = {
  tabs: 'reads the URL and title of every tab; the fill needs only the active one (activeTab)',
  webRequest: 'observes and can rewrite every request the browser makes',
  webRequestBlocking: 'as webRequest, and can block',
  cookies: 'reads session cookies for every site',
  history: 'reads everywhere the user has been',
  downloads: 'reads and writes the filesystem through the download directory',
  bookmarks: 'reads the user’s bookmarks',
  management: 'can enumerate and disable other extensions',
  debugger: 'attaches the devtools protocol to any page',
  proxy: 'redirects all traffic',
  nativeMessaging: 'talks to programs outside the browser',
  '<all_urls>': 'as a host permission it grants request-level access; DD-001 needs a content script match, not this',
};

/**
 * The content script may match all URLs — that is DD-001, argued and accepted.
 * Host *permissions* are a different capability and are not granted.
 */
const CONTENT_SCRIPT_MATCH = '<all_urls>';

const problems = [];
const reports = [];

for (const target of TARGETS) {
  const manifestPath = join(target.dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push(`${target.name}: no manifest at ${manifestPath}. Run \`pnpm run build:all\` first.`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const permissions = manifest.permissions ?? [];
  const hostPermissions = manifest.host_permissions ?? [];
  const optional = [...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? [])];

  for (const permission of [...permissions, ...hostPermissions, ...optional]) {
    if (permission in FORBIDDEN) {
      problems.push(`${target.name}: requests \`${permission}\` — ${FORBIDDEN[permission]}`);
    } else if (!ALLOWED.has(permission)) {
      // Not on either list. Unknown is a failure, not a pass: a permission this
      // script has never heard of is exactly the one nobody reviewed.
      problems.push(
        `${target.name}: requests \`${permission}\`, which NFR-008 does not permit. ` +
          `If it is genuinely needed, change the requirement first and say why.`,
      );
    }
  }

  if (hostPermissions.length > 0) {
    problems.push(
      `${target.name}: declares host_permissions (${hostPermissions.join(', ')}). ` +
        `DD-001 injects a content script; it does not need request-level host access.`,
    );
  }

  const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
  if (!matches.includes(CONTENT_SCRIPT_MATCH)) {
    problems.push(
      `${target.name}: the page agent no longer matches ${CONTENT_SCRIPT_MATCH}. ` +
        `That is DD-001's injection model; changing it changes what the product is.`,
    );
  }

  reports.push(
    `  ${target.name}: ${permissions.length} permission(s) — ${permissions.join(', ') || 'none'}` +
      `; content script matches ${matches.join(', ')}`,
  );
}

if (problems.length > 0) {
  console.error('\n✖ permission set does not match NFR-008:\n');
  for (const problem of problems) console.error(`    ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`✔ permissions match NFR-008 in ${TARGETS.length} target(s)`);
for (const report of reports) console.log(report);
