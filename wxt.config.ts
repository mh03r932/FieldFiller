import { defineConfig } from 'wxt';

// One config, two targets (NFR-017, DD-004). WXT absorbs the background model
// split — `service_worker` on Chromium, `background.scripts` on Firefox (C-003)
// — from the single `background.ts` entrypoint, so nothing below forks per
// browser except the two keys that genuinely differ.
export default defineConfig({
  srcDir: 'src',

  // Auto-imports off. Every symbol is imported explicitly so the import graph is
  // readable in the source, not just in the bundle — which is the whole point of
  // ND-4: nobody decided to ship Firebase to every page, an invisible import
  // graph decided it. `scripts/check-imports.mjs` can only be as trustworthy as
  // the imports it can see.
  imports: false,

  // C-001 / PD-003: MV3 on both browsers. WXT still defaults Firefox to MV2, so
  // without this the Firefox package ships MV2 — which Firefox accepts and the
  // Chrome Web Store does not, leaving the two targets on different manifest
  // models and NFR-017's single-codebase claim quietly false. Firefox 128
  // (NFR-016's floor) supports MV3 with an event-page background.
  manifestVersion: 3,

  vite: () => ({
    build: {
      modulePreload: {
        // Vite's module-preload polyfill injects `fetch(link.href)` into every
        // HTML entrypoint's chunk. It only ever requests extension-internal
        // URLs, so it makes no outbound request — but NFR-033 establishes G3 by
        // static reachability, not by intent, and a `fetch(` in shipped code
        // makes "no outbound request is possible" unprovable. Chrome 120 and
        // Firefox 128 (NFR-016's floor) both support `modulepreload` natively,
        // so the polyfill buys nothing and costs the claim.
        polyfill: false,
      },
    },
  }),

  manifest: ({ browser }) => ({
    // Resolved through the i18n catalog rather than hard-coded, from the very
    // first string (NFR-018). `default_locale` is what makes __MSG_ lookups
    // legal in the manifest at all.
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',

    // Exactly the set NFR-008 permits, and nothing else. `activeTab` is here
    // for the toolbar and command triggers; `scripting` for the per-frame fill
    // dispatch; `contextMenus` for the three scopes; `storage` for settings.
    // `tabs`, `webRequest`, `cookies`, `history` and `downloads` are forbidden
    // — the badge and profile resolution are built without `tabs` on purpose.
    permissions: ['storage', 'contextMenus', 'scripting', 'activeTab'],

    // FR-004. Declared with no popup on purpose: clicking the toolbar button
    // *fills*, it does not open a menu first. WXT only emits an `action` key by
    // itself when a popup entrypoint exists, so without this the button — the
    // zero-configuration path DD-007 relies on — would not exist at all.
    action: {},

    // DD-007. Declared in the prototype deliberately: a manifest is the only
    // thing that tells you a key is illegal (Chrome rejects Semicolon at load,
    // which is why fill-this-form ships Period). Fill-this-input ships with no
    // suggested_key at all — the user assigns it through the browser's own
    // shortcuts settings, and UC-030 is how they find out they can.
    commands: {
      'fill-all-inputs': {
        suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
        description: '__MSG_commandFillAllInputs__',
      },
      'fill-current-form': {
        suggested_key: { default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period' },
        description: '__MSG_commandFillCurrentForm__',
      },
      'fill-selected-input': {
        description: '__MSG_commandFillSelectedInput__',
      },
    },

    // NFR-016. Chromium and Firefox state their floor in different keys, so
    // this is one of the two places the manifest is target-specific.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              // C-004. Permanent once the add-on is listed on AMO, and not
              // before — change it here while that is still true.
              id: 'fieldfiller@dividbzero',
              strict_min_version: '128.0',
            },
          },
        }
      : { minimum_chrome_version: '120' }),
  }),
});
