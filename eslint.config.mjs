import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config. Deliberately small: the interesting rules here are the boundary
 * rules, not the style ones.
 *
 * Two of the project's structural decisions are enforced as lint rather than
 * left to review — the `chrome` global and the engine's import boundary. Both are
 * cheap to state now and expensive to reinstate once violated code exists
 * (ND-4, NFR-015).
 */
export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'public/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Everything goes through WXT's `browser`, which is the same object on
      // both targets. Reaching for the `chrome` global works on Chromium and
      // silently breaks Firefox — the exact class of divergence NFR-017 forbids,
      // and it is invisible in a Chromium-only test run.
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: "Import `browser` from 'wxt/browser' instead — `chrome` is Chromium-only (NFR-017)." },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },

  {
    // NFR-015: the fill engine must contain no reference to the extension API and
    // must be unit-testable without a browser host. Stated as a lint rule so a
    // convenience import is refused at the moment it is written, which is the
    // only moment it is cheap to refuse.
    // Every engine module, on both sides of the boundary: the page-side walk and
    // apply, the background-side persona and generators, the shared protocol and
    // the settings shape. `lib/platform/` is the only place allowed to know the
    // extension API exists.
    files: [
      'src/lib/page/**/*.ts',
      'src/lib/persona/**/*.ts',
      'src/lib/generators/**/*.ts',
      'src/lib/protocol.ts',
      'src/lib/settings.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wxt/browser', 'wxt/utils/*', 'webextension-polyfill', '@/lib/platform/*'],
              message:
                'The engine must not import the extension API or platform helpers (NFR-015). Take a DOM root or settings as an argument instead.',
            },
          ],
        },
      ],
    },
  },

  {
    // Build, gate and smoke scripts run in Node, outside the extension's
    // tsconfig. The project service is switched off for them rather than being
    // pointed at a default project: they are plain ESM with no types to check,
    // and routing them through a program only buys a file-count limit to trip
    // over as the number of gates grows.
    files: ['scripts/**/*.mjs', '*.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: false,
        project: false,
      },
    },
  },
);
