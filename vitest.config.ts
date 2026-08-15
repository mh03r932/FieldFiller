import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

/**
 * The WXT plugin gives tests the `@/` alias, the `import.meta.env` replacements,
 * and `fakeBrowser` — an in-memory extension API. Configured now so Phase 1's
 * engine tests have somewhere to land.
 *
 * NFR-015 is what makes this cheap: the engine takes a DOM root and returns
 * descriptors, or takes descriptors and returns values, so most of the suite
 * needs no extension host at all. `fakeBrowser` is for the wiring around it.
 */
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // The page-side engine is tested against a real DOM implementation rather
    // than against mocks, because the behaviours that matter here are the DOM's
    // own: `element.labels` resolving implicit labels, the prototype value
    // setter, and `InputEvent` being a distinct type from `Event`. Mocking those
    // would test the mock.
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      include: ['src/lib/**'],
      reporter: ['text', 'json-summary'],
      /**
       * NFR-012, enforced from 2026-08-15.
       *
       * Scoped by glob to exactly what the requirement names — "the fill engine
       * and generators" — rather than applied to `src/lib/**` as a whole. The
       * rest of that tree is the message contract and the two platform adapters,
       * which are thin wrappers over browser APIs: covering them means asserting
       * against a mock of `chrome.storage`, which tests the mock. A single
       * project-wide number would have to be set low enough to admit them, and
       * would then stop being a floor for the code that matters.
       *
       * Lines and functions only. NFR-012 asks for lines; branches sit at ~85%
       * here and the shortfall is mostly the defensive arms of platform guards —
       * worth having, not worth manufacturing a test for.
       */
      thresholds: {
        'src/lib/page/**': { lines: 90, functions: 90 },
        'src/lib/generators/**': { lines: 90, functions: 90 },
        'src/lib/persona/**': { lines: 90, functions: 90 },
      },
    },
  },
});
