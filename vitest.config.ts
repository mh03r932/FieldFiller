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
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      // NFR-012 requires 90% line coverage of the engine and generators. The
      // threshold is not enforced yet — there is no engine to cover, and a
      // threshold over an empty directory would either pass vacuously or block
      // every commit. Phase 1 turns it on with the walk.
      include: ['src/lib/**'],
      reporter: ['text', 'json-summary'],
    },
  },
});
