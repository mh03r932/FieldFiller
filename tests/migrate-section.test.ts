import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import type { OptionsHost } from '@/entrypoints/options/host';
import type * as I18n from '@/lib/platform/i18n';
import type * as MigrateSection from '@/entrypoints/options/migrate-section';
import type * as ImportSection from '@/entrypoints/options/import-section';

/**
 * The pick race (UC-027's section, and UC-026's beside it).
 *
 * `pending` is written only after `file.text()` resolves, and the chooser is
 * still mounted during that await — so a second pick starts a second read
 * and whichever resolves *last* wins the screen. A large first file
 * overwritten over a later pick was the finding; the guard makes last
 * *pick* win instead, whatever the reads' completion order.
 *
 * Driven deterministically with fake files whose `text()` resolves on a
 * controlled schedule — the one thing an e2e harness cannot do, and the
 * reason this is a unit test: the race only shows when the reads complete
 * out of order, and real `File.text()` on two small files never will.
 *
 * The same harness as `restore-section.test.ts`: the real catalog, the real
 * modules, re-imported per test because `pending` and the pick token are
 * module state by design.
 */

const CATALOG = JSON.parse(readFileSync('public/_locales/en/messages.json', 'utf8')) as Record<
  string,
  { message: string; placeholders?: Record<string, { content: string }> } | undefined
>;

/** The catalog, resolved the way `browser.i18n` resolves it (see restore-section.test.ts). */
function resolve(key: string, substitutions?: readonly string[]): string {
  const entry = CATALOG[key];
  if (entry === undefined) throw new Error(`no catalog entry: ${key}`);
  const slots = entry.placeholders ?? {};
  return entry.message
    .replaceAll(/\$([A-Z][A-Z0-9_]*)\$/g, (whole, name: string) => {
      const slot = slots[name.toLowerCase()];
      return slot === undefined ? whole : (substitutions?.[Number(slot.content.slice(1)) - 1] ?? '');
    })
    .replaceAll(/\$(\d)/g, (_, digit: string) => substitutions?.[Number(digit) - 1] ?? '');
}

vi.mock('@/lib/platform/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  message: resolve,
}));

type Modules = {
  migrate: typeof MigrateSection;
  import: typeof ImportSection;
};

let mod: Modules;

beforeEach(async () => {
  vi.resetModules();
  document.body.replaceChildren();
  mod = {
    migrate: await import('@/entrypoints/options/migrate-section'),
    import: await import('@/entrypoints/options/import-section'),
  };
});

function host(): OptionsHost {
  let settings: Settings = DEFAULT_SETTINGS;
  return {
    settings: () => settings,
    save: () => undefined,
    announce: () => undefined,
    replace: (next) => {
      settings = next;
      return Promise.resolve();
    },
    redraw: () => undefined,
  };
}

function sectionHost(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

/** A file-shaped object whose read resolves on the caller's schedule. */
function fakeFile(name: string, text: string, ms: number): File {
  return {
    name,
    size: text.length,
    text: () => new Promise<string>((resolve) => setTimeout(() => resolve(text), ms)),
  } as unknown as File;
}

/**
 * Picks `file` on the section's own chooser, as a real `change` event would.
 *
 * `files` is defined once per chooser with a mutable backing, because
 * happy-dom will not let a test redefine it per pick — and a real browser
 * only ever replaces the whole list, which is what this does.
 */
function pickFile(into: HTMLElement, selector: string, file: File | undefined): void {
  const chooser = into.querySelector<HTMLInputElement>(selector);
  if (chooser === null) throw new Error(`no ${selector}`);
  const holder = holders.get(chooser) ?? { files: [] as File[] };
  holders.set(chooser, holder);
  holder.files = file === undefined ? [] : [file];
  Object.defineProperty(chooser, 'files', { get: () => holder.files, configurable: true });
  chooser.dispatchEvent(new Event('change'));
}

const holders = new WeakMap<HTMLInputElement, { files: File[] }>();

const backup = (name: string): string =>
  JSON.stringify({ version: 1, fields: [{ type: 'text', name, match: [name] }], profiles: [] });

describe('the pick race', () => {
  it('a later pick wins even when the earlier file reads last (migrate)', async () => {
    const app = host();
    const into = sectionHost();
    mod.migrate.renderMigrate(app, into);

    // A reads slowly, B is picked after A and reads fast: without the guard,
    // A's late resolution overwrites B's already-rendered report.
    pickFile(into, '.migrate-file', fakeFile('a-slow.txt', backup('slow'), 80));
    pickFile(into, '.migrate-file', fakeFile('b-quick.txt', backup('quick'), 5));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const summary = into.querySelector('.migrate-summary')?.textContent ?? '';
    expect(summary).toContain('b-quick.txt');
    expect(summary).not.toContain('a-slow.txt');
  });

  it('a later pick wins even when the earlier file reads last (import)', async () => {
    const app = host();
    const into = sectionHost();
    mod.import.renderImport(app, into);

    // Our schema's JSON, not a backup: this section refuses Fake Filler
    // files by name, which would render a refusal instead of a plan.
    const ours = (label: string): string =>
      JSON.stringify({ version: 1, rules: [{ id: label, label, enabled: true, match: { mode: 'contains', pattern: label }, generator: { type: 'email' }, fromPersona: true }] });
    pickFile(into, '.import-file', fakeFile('a-slow.json', ours('slow'), 80));
    pickFile(into, '.import-file', fakeFile('b-quick.json', ours('quick'), 5));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const summary = into.querySelector('.import-summary')?.textContent ?? '';
    expect(summary).toContain('b-quick.json');
    expect(summary).not.toContain('a-slow.json');
  });

  it('a pick that fails to read still clears a superseded one, and the survivor renders', async () => {
    // The guard also covers the failure path: A's read rejects *after* B has
    // rendered, and the stale rejection neither clears B's pending file nor
    // announces over it.
    const app = host();
    const into = sectionHost();
    mod.migrate.renderMigrate(app, into);

    const failing: File = {
      name: 'a-gone.txt',
      size: 10,
      text: () =>
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('gone')), 80)),
    } as unknown as File;
    pickFile(into, '.migrate-file', failing);
    pickFile(into, '.migrate-file', fakeFile('b-quick.txt', backup('quick'), 5));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const summary = into.querySelector('.migrate-summary')?.textContent ?? '';
    expect(summary).toContain('b-quick.txt');
    // And the plan is still on screen — the stale rejection did not reset it.
    expect(into.querySelector('.migrate-plan')).not.toBeNull();
  });
});
