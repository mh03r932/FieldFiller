import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newRule } from '@/lib/rules/editing';
import { newProfile } from '@/lib/profiles';
import { DEFAULT_SETTINGS, type Matcher, type Profile, type Rule, type Settings } from '@/lib/settings';
import type { OptionsHost } from '@/entrypoints/options/host';
import type * as I18n from '@/lib/platform/i18n';
import type * as RuleEditor from '@/entrypoints/options/rules';
import type * as ProfilesSection from '@/entrypoints/options/profiles-section';
import type * as Sections from '@/entrypoints/options/sections';

/**
 * The options page's state that lives outside the DOM (UC-015 A3/A4, UC-024).
 *
 * Everything else on this page is a pure function over a list, asserted in
 * `editing.test.ts` and `profiles.test.ts` without a DOM. What is left is the
 * part that cannot be: three module-level facts — which rule is open, which list
 * it came from, and which profile is expanded — and a set of handlers that close
 * over the position their row held when it was drawn.
 *
 * Both are only wrong in the presence of a *second writer* (BR-024-3), and both
 * were wrong. A foreign write is the one input the browser harnesses cannot
 * easily stage and unit tests over `lib/` cannot see at all, so it is staged
 * here: a real DOM, the real modules, and settings replaced underneath them the
 * way another copy of the options page replaces them.
 *
 * The modules are re-imported per test because the state under test is
 * module-level by design — it has to survive the rebuild that destroys every
 * closure a render made — so one test's open rule would otherwise be the next
 * test's precondition.
 */

/**
 * The real catalog, rather than an identity function over keys.
 *
 * `fakeBrowser` has no `i18n` implementation, so something has to stand in. This
 * resolves against `public/_locales/en/messages.json` and throws on a key the
 * catalog does not carry, which makes every render below a check that the
 * strings it asks for exist — the failure NFR-018 otherwise shows as a blank
 * label on a screen nobody is looking at.
 */
const CATALOG: Record<string, { message: string } | undefined> = JSON.parse(
  readFileSync('public/_locales/en/messages.json', 'utf8'),
) as Record<string, { message: string }>;

function resolve(key: string, substitutions?: readonly string[]): string {
  const entry = CATALOG[key];
  if (entry === undefined) throw new Error(`no catalog entry: ${key}`);
  return entry.message.replaceAll(/\$(\d)/g, (_, digit: string) => substitutions?.[Number(digit) - 1] ?? '');
}

vi.mock('@/lib/platform/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  message: resolve,
}));

type Modules = {
  rules: typeof RuleEditor;
  profiles: typeof ProfilesSection;
  sections: typeof Sections;
};

let mod: Modules;

beforeEach(async () => {
  vi.resetModules();
  document.body.replaceChildren();
  mod = {
    rules: await import('@/entrypoints/options/rules'),
    profiles: await import('@/entrypoints/options/profiles-section'),
    sections: await import('@/entrypoints/options/sections'),
  };
});

/** The page's one state and one writer, with the writes visible to the test. */
function page(initial: Settings): {
  host: OptionsHost;
  current: () => Settings;
  foreign: (next: Settings) => void;
  announcements: readonly string[];
} {
  let settings = initial;
  const announcements: string[] = [];
  return {
    host: {
      settings: () => settings,
      save: (next) => {
        settings = next;
      },
      announce: (text) => {
        announcements.push(text);
      },
    },
    current: () => settings,
    // What the page's storage listener does with another writer's state once it
    // has decided the change was not its own: adopt into memory, no re-render.
    foreign: (next) => {
      settings = next;
    },
    announcements,
  };
}

function host(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

function rule(id: string, pattern: string): Rule {
  return { ...newRule(id), match: { mode: 'contains', pattern } };
}

function profile(id: string, overrides: Partial<Profile> = {}): Profile {
  return { ...newProfile(id), urls: ['*.example.com'], ...overrides };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function click(root: ParentNode, selector: string): void {
  const target = root.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`no ${selector}`);
  target.click();
}

function type(root: ParentNode, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/* ------------------------------------------------- BR-015-2: the open lens */

describe('the list an open rule belongs to', () => {
  it('is the list it was opened from, not the last list rendered', () => {
    const start = settings({
      rules: [rule('global-1', 'email')],
      profiles: [profile('p1', { rules: [rule('scoped-1', 'name')] })],
    });
    const app = page(start);
    const rulesInto = host();
    const profilesInto = host();

    mod.rules.renderRules(app.host, rulesInto);
    click(rulesInto, '[data-rule="global-1"] .rule-name');
    type(rulesInto, '[data-rule="global-1"] .rule-body input[type="text"]', 'renamed');
    expect(mod.rules.isEditingRule()).toBe(true);

    // Expanding a profile draws *its* rule list. Nothing about the open rule has
    // changed, and this used to repoint the open rule at the profile.
    mod.profiles.renderProfiles(app.host, profilesInto);
    click(profilesInto, '[data-profile="p1"] .profile-name');

    const theirs = settings({
      rules: [rule('global-1', 'email'), rule('global-2', 'phone')],
      profiles: [profile('p1', { rules: [rule('scoped-1', 'name')] })],
    });
    const adopted = mod.rules.adoptKeepingEdit(theirs, app.current());

    // Their new rule survives, the draft went back to the global list, and the
    // profile did not acquire a copy of it at top precedence.
    expect(adopted.rules.map((r) => r.id)).toEqual(['global-1', 'global-2']);
    expect(adopted.rules[0]?.label).toBe('renamed');
    expect(adopted.profiles[0]?.rules.map((r) => r.id)).toEqual(['scoped-1']);
  });

  it('survives a render of the global list while a profile rule is open', () => {
    const start = settings({
      rules: [rule('global-1', 'email')],
      profiles: [profile('p1', { rules: [rule('scoped-1', 'name')] })],
    });
    const app = page(start);
    const rulesInto = host();
    const profilesInto = host();

    mod.profiles.renderProfiles(app.host, profilesInto);
    click(profilesInto, '[data-profile="p1"] .profile-name');
    click(profilesInto, '[data-rule="scoped-1"] .rule-name');
    type(profilesInto, '[data-rule="scoped-1"] .rule-body input[type="text"]', 'scoped');

    // The global list redraws itself for its own reasons — a reorder, a delete,
    // a rule opened and closed. It is not this rule's list.
    mod.rules.renderRules(app.host, rulesInto);

    const theirs = settings({
      rules: [rule('global-1', 'email')],
      profiles: [profile('p1', { rules: [rule('scoped-1', 'name'), rule('scoped-2', 'city')] })],
    });
    const adopted = mod.rules.adoptKeepingEdit(theirs, app.current());

    expect(adopted.rules.map((r) => r.id)).toEqual(['global-1']);
    expect(adopted.profiles[0]?.rules.map((r) => r.id)).toEqual(['scoped-1', 'scoped-2']);
    expect(adopted.profiles[0]?.rules[0]?.label).toBe('scoped');
  });
});

/* ------------------------------- UC-015: an editor that outlives its screen */

describe('closing a profile closes the rule inside it', () => {
  const open = (app: ReturnType<typeof page>, into: HTMLElement): void => {
    mod.profiles.renderProfiles(app.host, into);
    click(into, '[data-profile="p1"] .profile-name');
    click(into, '[data-rule="scoped-1"] .rule-name');
    expect(mod.rules.isEditingRule()).toBe(true);
  };

  const withProfile = (): ReturnType<typeof page> =>
    page(settings({ profiles: [profile('p1', { rules: [rule('scoped-1', 'name')] })] }));

  it('when the profile is collapsed', () => {
    const app = withProfile();
    const into = host();
    open(app, into);

    click(into, '[data-profile="p1"] .profile-name');
    expect(mod.rules.isEditingRule()).toBe(false);
  });

  it('when another profile is expanded in its place', () => {
    const app = page(
      settings({
        profiles: [profile('p1', { rules: [rule('scoped-1', 'name')] }), profile('p2')],
      }),
    );
    const into = host();
    open(app, into);

    click(into, '[data-profile="p2"] .profile-name');
    expect(mod.rules.isEditingRule()).toBe(false);
  });

  it('when the profile is deleted here', () => {
    const app = withProfile();
    const into = host();
    open(app, into);

    // The one destructive action on this page is confirmed (BR-016-2), and
    // happy-dom carries no `confirm`.
    vi.stubGlobal('confirm', () => true);
    click(into, '[data-profile="p1"] .profile-delete');
    vi.unstubAllGlobals();
    expect(mod.rules.isEditingRule()).toBe(false);
  });

  it('when the profile is deleted somewhere else', () => {
    const app = withProfile();
    const into = host();
    open(app, into);

    app.foreign(settings({ profiles: [] }));
    expect(mod.profiles.closeIfProfileGone(app.current())).toBe(true);
    expect(mod.rules.isEditingRule()).toBe(false);
  });

  it('leaves a rule open in the global list alone', () => {
    const app = page(
      settings({ rules: [rule('global-1', 'email')], profiles: [profile('p1')] }),
    );
    const rulesInto = host();
    const profilesInto = host();

    mod.rules.renderRules(app.host, rulesInto);
    click(rulesInto, '[data-rule="global-1"] .rule-name');
    mod.profiles.renderProfiles(app.host, profilesInto);
    click(profilesInto, '[data-profile="p1"] .profile-name');
    click(profilesInto, '[data-profile="p1"] .profile-name');

    expect(mod.rules.isEditingRule()).toBe(true);
  });
});

/* ----------------------------- BR-024-3: rows addressed by position */

describe('rows whose list moved under them', () => {
  it('moves the profile it names rather than the one at its old position', () => {
    const app = page(settings({ profiles: [profile('a'), profile('b'), profile('c'), profile('d')] }));
    const into = host();
    mod.profiles.renderProfiles(app.host, into);

    app.foreign(settings({ profiles: [profile('b'), profile('c'), profile('d')] }));
    click(into, '[data-profile="c"] .rule-order button[data-direction="up"]');

    expect(app.current().profiles.map((p) => p.id)).toEqual(['c', 'b', 'd']);
  });

  it('refuses to move a profile that is gone, and says so', () => {
    const app = page(settings({ profiles: [profile('a'), profile('b')] }));
    const into = host();
    mod.profiles.renderProfiles(app.host, into);

    app.foreign(settings({ profiles: [profile('b')] }));
    click(into, '[data-profile="a"] .rule-order button[data-direction="down"]');

    expect(app.current().profiles.map((p) => p.id)).toEqual(['b']);
    expect(app.announcements).toHaveLength(1);
  });

  it('refuses to write a profile address pattern through a shifted index', () => {
    const app = page(settings({ profiles: [profile('p1', { urls: ['a.test', 'b.test'] })] }));
    const into = host();
    mod.profiles.renderProfiles(app.host, into);
    click(into, '[data-profile="p1"] .profile-name');

    app.foreign(settings({ profiles: [profile('p1', { urls: ['b.test'] })] }));
    type(into, '[data-profile="p1"] [data-url="1"] input[type="text"]', 'typed.test');

    expect(app.current().profiles[0]?.urls).toEqual(['b.test']);
    expect(app.announcements).toHaveLength(1);
  });

  it('refuses to delete a profile address pattern through a shifted index', () => {
    const app = page(settings({ profiles: [profile('p1', { urls: ['a.test', 'b.test'] })] }));
    const into = host();
    mod.profiles.renderProfiles(app.host, into);
    click(into, '[data-profile="p1"] .profile-name');

    app.foreign(settings({ profiles: [profile('p1', { urls: ['x.test', 'a.test', 'b.test'] })] }));
    click(into, '[data-profile="p1"] [data-url="0"] .exclusion-delete');

    expect(app.current().profiles[0]?.urls).toEqual(['x.test', 'a.test', 'b.test']);
  });

  it('still edits its own row across its own keystrokes', () => {
    const app = page(settings({ profiles: [profile('p1', { urls: ['a.test', 'b.test'] })] }));
    const into = host();
    mod.profiles.renderProfiles(app.host, into);
    click(into, '[data-profile="p1"] .profile-name');

    const selector = '[data-profile="p1"] [data-url="1"] input[type="text"]';
    type(into, selector, 'b');
    type(into, selector, 'b.t');
    type(into, selector, 'b.tes');

    expect(app.current().profiles[0]?.urls).toEqual(['a.test', 'b.tes']);
    expect(app.announcements).toHaveLength(0);
  });

  it('refuses to delete a domain exclusion through a shifted index', () => {
    const app = page(
      settings({
        exclusions: { ...DEFAULT_SETTINGS.exclusions, domains: ['bank.test', 'mail.test'] },
      }),
    );
    const into = host();
    mod.sections.renderDomainExclusions(app.host, into);

    app.foreign(
      settings({
        exclusions: { ...DEFAULT_SETTINGS.exclusions, domains: ['new.test', 'bank.test', 'mail.test'] },
      }),
    );
    click(into, '[data-domain="0"] .exclusion-delete');

    // `bank.test` sat at 0 when the row was drawn and sits at 1 now. Writing
    // through the captured index would have removed `new.test` instead.
    expect(app.current().exclusions.domains).toEqual(['new.test', 'bank.test', 'mail.test']);
    expect(app.announcements).toHaveLength(1);
  });

  it('refuses to write a field exclusion through a shifted index', () => {
    const fields: readonly Matcher[] = [
      { mode: 'contains', pattern: 'card' },
      { mode: 'contains', pattern: 'cvv' },
    ];
    const app = page(settings({ exclusions: { ...DEFAULT_SETTINGS.exclusions, fields } }));
    const into = host();
    mod.sections.renderFieldExclusions(app.host, into);

    app.foreign(
      settings({
        exclusions: { ...DEFAULT_SETTINGS.exclusions, fields: [{ mode: 'contains', pattern: 'cvv' }] },
      }),
    );
    type(into, '[data-exclusion="1"] input[type="text"]', 'iban');

    expect(app.current().exclusions.fields).toEqual([{ mode: 'contains', pattern: 'cvv' }]);
    expect(app.announcements).toHaveLength(1);
  });
});
