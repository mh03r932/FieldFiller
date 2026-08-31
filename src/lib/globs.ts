/**
 * URL globs in the vocabulary of extension match patterns: `*` stands for any
 * run of characters, everything else is literal, and the port takes no part
 * (FR-037, FR-074, DD-005).
 *
 * Lives at `lib/` root rather than under `lib/page/` because the page never
 * matches a glob: exclusion is decided in the background before any agent is
 * spoken to (BR-008-4), and profile resolution is a background-side scan of
 * the settings. Both import from here, and neither should reach into a module
 * whose other half watches the DOM.
 *
 * Deliberately not a regular expression — this runs on a URL before every
 * fill, and a second catastrophic-backtracking surface there is exactly where
 * NFR-009 is hardest to guarantee. `segmentsMatch` is what makes that true
 * rather than intended.
 */

/**
 * A URL or pattern taken apart into the three things a match pattern names.
 *
 * Structural, and it has to be: matching the glob against the whole URL string
 * makes every literal a substring test, so `*.example.com/*` matched
 * `https://evil.test/?redirect=https://sub.example.com/` — the host it names
 * appearing in somebody else's query string. That direction is fail-*closed*, so
 * the damage is a page the user never listed silently refusing to fill; it is
 * also the direction that quietly stops being about exclusion at all, because
 * `matchesGlob` is the matcher Phase 5's profile URLs use, where over-matching
 * changes which rules run.
 *
 * The port goes (see below), and so does any `user:pass@`: the host is what the
 * browser resolved, and `https://example.com@evil.test/` is a page on
 * `evil.test`. Leaving the userinfo in would let it be read as a host by a
 * pattern that names one, in the direction that fills a page it should not.
 */
type UrlParts = { readonly scheme: string; readonly host: string; readonly path: string };

/**
 * Extension match patterns have no port: the host is a host, and matching
 * ignores the port the page is served on. Ours claimed that vocabulary and did
 * not implement it — `localhost/*` expanded to a matcher that
 * `http://localhost:3000/` failed, so an exclusion on any ported URL was
 * accepted, listed, and silently inert. Silently is the whole problem: an
 * exclusion that fails to match fails **open**, and a pattern matching nothing
 * looks exactly like a page nobody excluded.
 *
 * Only a trailing `:digits` goes: `[::1]:8080` keeps its brackets, and
 * `user:pass@host` loses the credentials rather than a port.
 *
 * `emptyPath` is what a value with no path at all means, and the two sides
 * differ. A URL means the root — `http://localhost` and `http://localhost/` are
 * the same page. A pattern means any path: someone typing a domain into a field
 * labelled "excluded domains" means the domain, and reading it as "the root and
 * nothing else" would be the silent failure again in a different hat.
 */
function parse(value: string, emptyPath: string): UrlParts {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return { scheme: '', host: value, path: emptyPath };

  const authorityStart = schemeEnd + '://'.length;
  const pathStart = value.indexOf('/', authorityStart);
  const authority = pathStart === -1 ? value.slice(authorityStart) : value.slice(authorityStart, pathStart);
  const at = authority.lastIndexOf('@');

  return {
    scheme: value.slice(0, schemeEnd),
    host: authority.slice(at + 1).replace(/:\d+$/, ''),
    path: pathStart === -1 ? emptyPath : value.slice(pathStart),
  };
}

/**
 * Whether a glob's literal segments appear in order, without backtracking.
 *
 * `*` stands for any run of characters and every other character is literal, so
 * a pattern is a list of literals that must appear in order — anchored at each
 * end unless the pattern starts or ends with a star. Each literal is then found
 * with one forward `indexOf` from where the previous one ended, and taking the
 * earliest occurrence is safe: a later one can only match a suffix of what an
 * earlier one already covers, so nothing is lost by not going back.
 *
 * **Not a regular expression, and the difference is the point.** Translating
 * `*` to `.*` was the obvious implementation and it is the textbook
 * catastrophic-backtracking shape: `*a*a*a*a*a*a*a*a*a*z` against a URL ending
 * in a run of `a`s made the engine try every way to divide the run between the
 * stars. Measured before this was replaced, that pattern took 3 ms at 20
 * trailing characters, 3.2 s at 40 and 33 s at 50 — on a string a page can make
 * arbitrarily long, in a check that runs in the background before every fill
 * (BR-008-1). The module comment claimed to be avoiding exactly this and was
 * describing an intention rather than the code.
 *
 * Patterns can only be written into storage by hand today, so nothing reachable
 * exploits it. Phase 4 gives them an editor and Phase 6 gives them import and
 * sync, and a shared configuration that stops every fill in the browser is not a
 * failure worth shipping the ingredients for.
 */
function segmentsMatch(text: string, pattern: string): boolean {
  const parts = pattern.split('*');
  // No star at all: the pattern is one literal, and must be the whole string.
  if (parts.length === 1) return text === pattern;

  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  const middle = parts.slice(1, -1);

  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  // Guards the case where the anchors overlap: `ab*ba` must not match `aba` by
  // letting the prefix and suffix share a character.
  if (text.length < first.length + last.length) return false;

  let at = first.length;
  const limit = text.length - last.length;
  for (const part of middle) {
    if (part === '') continue;
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > limit) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether an exclusion or profile glob matches a URL (FR-037, FR-074, DD-005).
 *
 * Case is folded rather than delegated to a regex flag, which is the only thing
 * the `i` flag was doing. Hosts and schemes are ASCII, and the path is compared
 * the same way it always was.
 *
 * A pattern with no scheme matches any scheme, so `example.com/*` behaves the
 * way a user who typed a domain expects rather than silently never matching.
 */
export function matchesGlob(url: string, pattern: string): boolean {
  if (pattern === '') return false;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) || pattern.startsWith('*://');
  const wanted = parse((hasScheme ? pattern : `*://${pattern}`).toLowerCase(), '/*');
  const actual = parse(url.toLowerCase(), '/');

  // Each part against its own part, never the glob against the whole string. A
  // host pattern must match the host, not merely appear somewhere in the URL.
  return (
    segmentsMatch(actual.scheme, wanted.scheme) &&
    segmentsMatch(actual.host, wanted.host) &&
    segmentsMatch(actual.path, wanted.path)
  );
}

/** Whether any pattern excludes this URL. Returns the pattern, for the report. */
export function excludedBy(url: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesGlob(url, pattern));
}
