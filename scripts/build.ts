import { build } from "esbuild";

const shared = {
  bundle: true,
  minify: true,
  platform: "node" as const,
  format: "esm" as const,
  mainFields: ["module", "main"],
  external: ["pacote", "tar"],
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const maa = new Proxy({}, {
  get(_, prop) { return globalThis.maa?.[prop]; },
  set(_, prop, value) { globalThis.maa[prop] = value; return true; },
  has(_, prop) { return prop in (globalThis.maa || {}); },
});
`,
  },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["server/index.ts"],
    outfile: "server/dist/maa-pipeline-lsp.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["server/runtime.ts"],
    outfile: "server/dist/maa-runtime.mjs",
  }),
]);
