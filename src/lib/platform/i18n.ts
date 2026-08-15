import { browser } from 'wxt/browser';

/**
 * String resolution through the i18n catalog (NFR-018).
 *
 * Lives under `lib/platform/` rather than `lib/engine/` because it touches the
 * extension API. The engine may not import anything from here — that boundary is
 * NFR-015, and `scripts/check-imports.mjs` enforces it.
 */

/**
 * Every key present in `public/_locales/en/messages.json`.
 *
 * WXT generates a `getMessage` overload carrying the catalog's keys as a union,
 * so a mistyped key is a compile error rather than a blank label. This extracts
 * that union instead of restating it — a hand-maintained copy would drift from
 * the catalog, which is the failure the type exists to prevent.
 */
export type MessageKey = Parameters<typeof browser.i18n.getMessage>[0];

/**
 * One catalog string, with `$1`…`$9` substituted where given.
 *
 * Substitution is the browser's own, not a template in our code, because the
 * order of the pieces belongs to the translation: "6 filled in this form" and
 * its equivalent in a language that puts the scope first are the same message
 * with the same substitutions, and a sentence assembled by concatenation here
 * could only ever be translated one way (NFR-018).
 */
export function message(key: MessageKey, substitutions?: readonly string[]): string {
  return browser.i18n.getMessage(key, substitutions === undefined ? undefined : [...substitutions]);
}

/**
 * Fills every `[data-i18n]` element in `root` from the catalog.
 *
 * The key arrives from an HTML attribute, which TypeScript cannot check, so this
 * is the one place a cast is unavoidable. The runtime fallback is the real
 * control: `getMessage` returns "" for an unknown key, and rendering the key in
 * brackets makes a typo visible in the page instead of silently producing an
 * empty label (NFR-020 — a failure should name its own cause).
 */
export function localise(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset['i18n'];
    if (key === undefined || key === '') continue;

    const resolved = browser.i18n.getMessage(key as MessageKey);
    element.textContent = resolved === '' ? `[${key}]` : resolved;
  }
}
