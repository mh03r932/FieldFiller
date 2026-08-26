import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Rule, type Settings } from '@/lib/settings';
import type { OptionsHost } from '@/entrypoints/options/host';
import type * as I18n from '@/lib/platform/i18n';
import type * as Sections from '@/entrypoints/options/sections';
import type * as ImportSection from '@/entrypoints/options/import-section';
import type * as RestoreSection from '@/entrypoints/options/restore-section';

/**
 * The restore confirmation against a second writer (UC-028, BR-024-3).
 *
 * `restore.test.ts` holds the analysis — the counts and the already-defaults
 * answer as functions. What is left is the part that cannot be asserted there:
 * the section as DOM, in the state the page's focus-skip rule creates. Opening
 * the confirmation focuses its cancel button, so a foreign write arriving while
 * it is open is adopted without this section ever being re-rendered — and the
 * confirmation is the one surface on this page whose whole content is a claim
 * about the settings it describes (BR-028-2).
 *
 * The same harness as `options-lists.test.ts`: the real catalog, the real
 * modules, and settings replaced underneath them the way another copy of the
 * options page replaces them. Re-imported per test because `confirming` is
 * module state by design — it has to survive the rebuild that destroys every
 * closure a render made.
 */

const CATALOG = JSON.parse(readFileSync('public/_locales/en/messages.json', 'utf8')) as Record<
  string,
  { message: string; placeholders?: Record<string, { content: string }> } | undefined
>;

/**
 * The catalog, resolved the way `browser.i18n` resolves it — which `fakeBrowser`
 * does not (see `options-lists.test.ts`'s note). Named placeholders first
 * (`$RULES$` → the substitution its `$1` content names), bare `$1` after, so
 * the counts sentence can be asserted word for word: a summary that silently
 * kept its `$RULES$` would pass any containment check while saying nothing.
 */
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
  sections: typeof Sections;
  import: typeof ImportSection;
  restore: typeof RestoreSection;
};

let mod: Modules;

beforeEach(async () => {
  vi.resetModules();
  document.body.replaceChildren();
  mod = {
    sections: await import('@/entrypoints/options/sections'),
    import: await import('@/entrypoints/options/import-section'),
    restore: await import('@/entrypoints/options/restore-section'),
  };
});

/** The page's one state, with the foreign write staged the way adoption does it. */
function page(initial: Settings): {
  host: OptionsHost;
  foreign: (next: Settings) => void;
} {
  let settings = initial;
  return {
    host: {
      settings: () => settings,
      save: () => undefined,
      announce: () => undefined,
      replace: (next) => {
        settings = next;
        return Promise.resolve();
      },
      redraw: () => undefined,
    },
    foreign: (next) => {
      settings = next;
    },
  };
}

function sectionHost(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

function rule(pattern: string, index: number): Rule {
  return {
    id: `r${index}`,
    label: pattern,
    enabled: true,
    match: { mode: 'contains', pattern },
    generator: { type: 'email' },
    fromPersona: true,
  };
}

/** A configured state with `count` rules, the one number the summary names. */
function rules(count: number): Settings {
  return {
    ...DEFAULT_SETTINGS,
    rules: Array.from({ length: count }, (_, index) => rule(`pattern-${index}`, index)),
  };
}

/**
 * The state between adding a rule and typing its pattern: in this page's
 * memory, dropped by the parser, and therefore discarded by no write at all.
 */
function halfWritten(): Settings {
  return { ...DEFAULT_SETTINGS, rules: [rule('', 0)] };
}

function click(root: ParentNode, selector: string): void {
  const target = root.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`no ${selector}`);
  target.click();
}

function summaryText(into: ParentNode): string {
  const summary = into.querySelector('.restore-summary');
  if (summary === null) throw new Error('no summary');
  // `String` rather than `?? ''`: a null here is a bug worth seeing as 'null'
  // in the diff, not an empty string that fails by absence.
  return String(summary.textContent);
}

describe('the confirmation a foreign write arrives on', () => {
  it('registers a refresh, which the adoption render calls on the section it skips', () => {
    // The focus-skip is `main.ts`'s one-line decision; what can be held here is
    // that the registry hands it something for this section.
    const entry = mod.sections.SECTIONS.find((section) => section.id === 'restore');
    expect(entry?.render).toBe(mod.restore.renderRestore);
    expect(entry?.refresh).toBe(mod.restore.refreshRestore);
  });

  it('registers the import preview’s refresh under the same contract', () => {
    // The same review that found the restore counts going stale across
    // same-page saves named the import preview’s "what is there now" half as
    // the sibling gap, and the same save loop in `main.ts` is the caller for
    // both. Pinned here so a section that grows computed text over live
    // settings without a refresh is a failing test rather than a lying
    // sentence — the registry is what the loop iterates.
    const entry = mod.sections.SECTIONS.find((section) => section.id === 'import');
    expect(entry?.refresh).toBe(mod.import.refreshImport);
  });

  it('opens focused on cancel — the state that makes the adoption render skip', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);

    click(into, '.restore-button');

    expect(into.querySelector('.restore-cancel')).toBe(document.activeElement);
  });

  it('cannot say a number and "nothing is discarded" about the same state', () => {
    // The half-written rule, as one state: the summary must name zero rules
    // beside an already-defaults line, not one rule beside it. Each half true
    // by its own discipline is still the screen lying (BR-028-2).
    const app = page(halfWritten());
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);

    click(into, '.restore-button');

    expect(into.querySelector('.restore-already')).not.toBeNull();
    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['0', '0', '0', '0']));
  });

  it('patches its counts in place when the adoption render skips it', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);
    click(into, '.restore-button');
    const cancel = into.querySelector('.restore-cancel');
    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['1', '0', '0', '0']));

    // What `renderSections` does for the section that held the focus: the
    // foreign state is adopted into memory, the refresh runs, no render does.
    app.foreign(rules(3));
    mod.restore.refreshRestore(app.host, into);

    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['3', '0', '0', '0']));
    // Nothing was rebuilt: the same button node, still holding the focus the
    // skip exists to protect.
    expect(into.querySelector('.restore-cancel')).toBe(cancel);
    expect(document.activeElement).toBe(cancel);
  });

  it('adds and removes the already-defaults line as the state crosses the line', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);
    click(into, '.restore-button');
    expect(into.querySelector('.restore-already')).toBeNull();

    app.foreign(DEFAULT_SETTINGS);
    mod.restore.refreshRestore(app.host, into);
    expect(into.querySelector('.restore-already')).not.toBeNull();
    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['0', '0', '0', '0']));

    app.foreign(rules(2));
    mod.restore.refreshRestore(app.host, into);
    expect(into.querySelector('.restore-already')).toBeNull();
    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['2', '0', '0', '0']));
  });

  it('puts a line that appeared mid-confirmation where a render would have put it', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);
    click(into, '.restore-button');

    app.foreign(DEFAULT_SETTINGS);
    mod.restore.refreshRestore(app.host, into);

    // Between the counts it qualifies and the no-undo sentence it does not:
    // the order a fresh render produces, so a patched confirmation is never
    // distinguishable from a rebuilt one by where its lines sit.
    const plan = into.querySelector('.restore-plan');
    expect(Array.from(plan?.children ?? []).map((child) => child.className)).toEqual([
      'restore-summary',
      'hint restore-already',
      'hint restore-no-undo',
      'restore-actions',
    ]);
  });

  it('is a no-op with the confirmation closed', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);

    app.foreign(rules(3));
    mod.restore.refreshRestore(app.host, into);

    expect(into.querySelector('.restore-plan')).toBeNull();
    expect(into.querySelector('.restore-button')).not.toBeNull();
  });

  it('shows the new counts on a plain render, where nothing held the focus', () => {
    const app = page(rules(1));
    const into = sectionHost();
    mod.restore.renderRestore(app.host, into);
    click(into, '.restore-button');

    app.foreign(rules(3));
    mod.restore.renderRestore(app.host, into);

    expect(summaryText(into)).toBe(resolve('restorePlanCounts', ['3', '0', '0', '0']));
  });
});
