import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/**
 * Bundles the engine suite for a browser that has no extension in it.
 *
 * Vite rather than a new bundler: it is what builds the product (through WXT),
 * so this adds no dependency and no second set of resolution rules. The `@/`
 * alias is restated here because this build does not go through WXT's config.
 *
 * Output is a single ES module with no imports left, so the test page can load
 * it with one `<script type="module">` and nothing has to be served from
 * `node_modules`.
 *
 * A plain object rather than `defineConfig`, which is only a typing helper — and
 * this file is checked by neither `tsc` nor a typed lint pass, so calling it
 * would buy nothing. Vite itself is a declared devDependency: it arrived here as
 * WXT's transitive one and was used at that footing for a while, which worked
 * only for as long as pnpm happened to keep a `vite` bin in `node_modules/.bin`
 * for a package this project never asked for. A harness that runs on every change
 * should not rest on the shape of somebody else's dependency tree.
 */
export default ({
  root: ROOT,
  resolve: {
    alias: { '@': join(ROOT, 'src') },
  },
  build: {
    outDir: join(ROOT, '.output', 'firefox-engine'),
    emptyOutDir: true,
    // No minification: when this fails, the stack trace is the whole diagnostic
    // and a mangled one costs more than the bytes save.
    minify: false,
    target: 'firefox128',
    lib: {
      entry: join(HERE, 'engine-suite.ts'),
      formats: ['es'],
      fileName: () => 'engine-suite.js',
    },
  },
});
