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
        // URL globs (FR-037, FR-074), extracted from `lib/page/scope.ts`
        // 2026-08-30 because the page never matches one — both callers are
        // background-side. Held to the page floor it was written under: the
        // matcher decides which pages are excluded and which profile runs, and
        // both of those fail open — a pattern that matches nothing looks
        // exactly like a page nobody excluded.
        'src/lib/globs.ts': { lines: 90, functions: 90 },
        // The shared coercions, extracted 2026-08-30 from three drifting
        // copies. A floor because a coercion's failure is a silence: the wrong
        // branch returns defaults with their work missing and no error
        // anywhere — the argument the settings floor below makes, at the
        // outermost step of the same read.
        'src/lib/coerce.ts': { lines: 90, functions: 90 },
        // One line, but gated rather than allowlisted for the same reason the
        // settings floor exists: this is the sentence a failure is reported
        // in, and an uncovered branch here is a caught error rendered as
        // "[object Object]" to the user it happened to.
        'src/lib/reason.ts': { lines: 90, functions: 90 },
        'src/lib/generators/**': { lines: 90, functions: 90 },
        'src/lib/persona/**': { lines: 90, functions: 90 },
        // The rule model (DD-005). Held to the same floor as the generators it
        // sits in front of: a pattern analyser or a template parser with
        // untested branches is precisely where a wrong answer is invisible.
        'src/lib/rules/**': { lines: 90, functions: 90 },
        // The result surface (DD-006). What it decides — how a field is named,
        // which outcome joins to which control, whether the badge marks a capped
        // fill — is invisible when wrong, which is the argument for the floor.
        'src/lib/report/**': { lines: 90, functions: 90 },
        // The two files that sit directly under `src/lib`, added 2026-08-15
        // after `scripts/check-coverage-scope.mjs` found them measured by
        // coverage and gated by nothing — `settings.ts` at 62% lines a day after
        // it was written, `protocol.ts` at 22%.
        //
        // Both fail quietly by construction, which is the argument. The tolerant
        // parser drops what it cannot read rather than throwing, so a wrong
        // coercion returns a user's settings with their work missing and no
        // error anywhere. The message guards decide what the background is
        // allowed to believe about a page agent that may be a previous build.
        'src/lib/settings.ts': { lines: 90, functions: 90 },
        // The export file's shape (UC-025), added 2026-08-22. Held to the same
        // floor as the schema it serialises and for a sharper version of the
        // same argument: this module's failure is a file that looks right. A
        // key emitted in the wrong order costs nothing but a meaningless diff;
        // a generator whose configuration is dropped exports as a valid rule of
        // the wrong kind, and neither end reports anything.
        'src/lib/settings-file.ts': { lines: 90, functions: 90 },
        // The import analysis (UC-026), added 2026-08-22. The floor is argued
        // more sharply here than anywhere else in this list: what this module
        // gets wrong is a *silence*. The tolerant parser cannot fail, so every
        // entry this analysis does not name is one the user is never told they
        // lost — and they find out on the next page they fill.
        'src/lib/settings-import.ts': { lines: 90, functions: 90 },
        // The restore analysis (UC-028), added 2026-08-24. Small, but held to
        // the floor for the same reason the import analysis is: the counts are
        // the confirmation, and a count that disagrees with the state it
        // describes is a user agreeing to a number that is not true.
        'src/lib/restore.ts': { lines: 90, functions: 90 },
        // The migration analysis (UC-027), added 2026-08-25, held to the same
        // floor as the import analysis it mirrors and for its sharper
        // argument: this module's failure is a *lookalike* — a backup
        // translated into something that stores cleanly and behaves
        // differently from what the user configured. Every branch below is
        // one mapping, and the wrong branch is invisible until the next
        // page the migrant fills.
        'src/lib/fakefiller-migrate.ts': { lines: 90, functions: 90 },
        // Backup recognition (UC-027 step 3). The one property worth a floor:
        // the importer and the migrator must agree about what a Fake Filler
        // backup is, and they do it by importing this module — an untested
        // branch here is a file one surface accepts and the other disowns.
        'src/lib/fakefiller-recognise.ts': { lines: 90, functions: 90 },
        // The synchronised replica (UC-029), added 2026-08-28. The floor is the
        // import analysis's argument in a store the user cannot open: what this
        // module gets wrong is which configuration a *second* machine ends up
        // with, and every wrong answer looks like a working feature from either
        // screen. The completeness check is the sharpest case — read a shard
        // short and a device adopts a prefix of somebody's rule list as though
        // it were the list, with both browsers reporting success.
        'src/lib/sync.ts': { lines: 90, functions: 90 },
        'src/lib/protocol.ts': { lines: 90, functions: 90 },
        // The exclusion list operations (UC-020, UC-021), added 2026-08-17 with
        // the screens that author them. Same floor and the same argument as the
        // rule list operations next door: an off-by-one in a removal takes out
        // the wrong exclusion, and an exclusion silently gone is a page that
        // silently gets filled.
        'src/lib/exclusions.ts': { lines: 90, functions: 90 },
        // Profile resolution and the list operations under it (Phase 5). Both
        // fail silently when wrong, which is the argument for the floor: the
        // wrong profile means the wrong rules ran, and the fill still reports
        // success on every field it filled.
        'src/lib/profiles.ts': { lines: 90, functions: 90 },
        'src/lib/lists.ts': { lines: 90, functions: 90 },
      },
    },
  },
});
