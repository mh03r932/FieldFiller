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
 * A plain object rather than `defineConfig`. Vite is a transitive dependency
 * through WXT, so importing it by name from here is not resolvable under pnpm's
 * strict layout — and `defineConfig` is only a typing helper, so the config
 * loses nothing by not calling it.
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
