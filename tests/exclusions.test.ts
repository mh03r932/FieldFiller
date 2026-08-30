import { describe, expect, it } from 'vitest';
import { appendAt, newExclusion, removeAt, replaceAt } from '@/lib/exclusions';
import { validateDomainPattern, validateMatcher } from '@/lib/rules/validate';
import { excludedBy } from '@/lib/globs';
import { parseSettings, type Matcher } from '@/lib/settings';

/**
 * The two exclusion lists, without a page (UC-020, UC-021).
 *
 * The same argument the rule editor's tests make: what the screens have to get
 * right is what a list *becomes*, and a failure asserted here names an operation
 * rather than a selector.
 */
describe('exclusion list operations', () => {
  const a: Matcher = { mode: 'contains', pattern: 'captcha' };
  const b: Matcher = { mode: 'regex', pattern: '^coupon' };

  it('appends rather than inserting', () => {
    // Order carries no precedence for an exclusion — every entry is consulted —
    // so appending is for predictability rather than for meaning.
    expect(appendAt([a], b)).toEqual([a, b]);
  });

  it('replaces one entry and leaves its neighbours alone', () => {
    const changed: Matcher = { mode: 'exact', pattern: 'captcha' };
    expect(replaceAt([a, b], 0, changed)).toEqual([changed, b]);
  });

  it('removes by position, not by value', () => {
    // Two identical patterns are a redundant configuration, not an illegal one.
    // Removing "the entry equal to this" would take the first of them however
    // far down the list the user clicked.
    expect(removeAt([a, a, b], 1)).toEqual([a, b]);
  });

  it('leaves the list alone for a position that is not in it', () => {
    expect(removeAt([a, b], 7)).toEqual([a, b]);
    expect(replaceAt([a, b], 7, a)).toEqual([a, b]);
  });

  it('starts a new field exclusion in contains mode', () => {
    // `regex` would make `credit.card` quietly match `credit-card` as well,
    // which is not what someone typing a field name means.
    expect(newExclusion()).toEqual({ mode: 'contains', pattern: '' });
  });

  it('reports a new exclusion as incomplete rather than storing it silently', () => {
    expect(validateMatcher(newExclusion())).toEqual([
      { field: 'match', code: 'ruleProblemPatternEmpty' },
    ]);
  });
});

describe('domain pattern validation (UC-021)', () => {
  it('accepts the shapes the hint teaches', () => {
    for (const pattern of ['*.example.com/*', 'localhost/*', 'https://bank.test/*', 'example.com']) {
      expect(validateDomainPattern(pattern)).toBeUndefined();
    }
  });

  it('refuses an empty pattern', () => {
    expect(validateDomainPattern('')).toBe('domainProblemEmpty');
  });

  it('refuses whitespace, because such a pattern fails open', () => {
    // An address contains no spaces, so this matches nothing — and an exclusion
    // that matches nothing looks exactly like a site nobody excluded. It is also
    // the likeliest thing to arrive by paste.
    expect(validateDomainPattern('example.com /*')).toBe('domainProblemWhitespace');
    expect(validateDomainPattern('\texample.com')).toBe('domainProblemWhitespace');
  });

  it('accepts a pattern that excludes everything, and it really does', () => {
    // Deliberately allowed: there is no other global off switch, and refusing it
    // would be this screen deciding what the list is for. The cost is UC-021 A3
    // — a pattern passes through `*` on its way to `*.example.com`, and a fill
    // invoked during that keystroke is refused. Closed, not open, and transient.
    expect(validateDomainPattern('*')).toBeUndefined();
    expect(excludedBy('https://anything.test/page', ['*'])).toBe('*');
  });
});

describe('an authored exclusion survives the round trip through storage', () => {
  it('keeps every mode a screen can produce', () => {
    // The screens write whole settings states through `parseSettings`, so an
    // entry the parser drops is an entry the user watches disappear. All three
    // modes have to survive, not just the one the editor starts in.
    const fields: Matcher[] = [
      { mode: 'contains', pattern: 'captcha' },
      { mode: 'exact', pattern: 'coupon' },
      { mode: 'regex', pattern: '^promo\\d+$' },
    ];
    const parsed = parseSettings({ exclusions: { fields, domains: ['*.example.com/*'] } });

    expect(parsed.exclusions.fields).toEqual(fields);
    expect(parsed.exclusions.domains).toEqual(['*.example.com/*']);
  });

  it('drops a half-typed entry rather than storing a pattern that matches everything', () => {
    // An empty `contains` pattern compiles to the empty regular expression,
    // which matches every field. The parser refuses it for that reason, so the
    // blank row a user has just added excludes nothing while they type into it.
    expect(parseSettings({ exclusions: { fields: [newExclusion()] } }).exclusions.fields).toEqual([]);
  });
});
