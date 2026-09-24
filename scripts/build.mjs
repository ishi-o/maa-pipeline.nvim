import { build } from 'esbuild'

const shared = {
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  mainFields: ['module', 'main'],
  banner: {
    js: "import { createRequire } from 'node:module'; import { fileURLToPath as bundleFileURLToPath } from 'node:url'; import { dirname as bundleDirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = bundleFileURLToPath(import.meta.url); const __dirname = bundleDirname(__filename);"
  }
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ['server/index.mjs'],
    outfile: 'server/dist/maa-pipeline-lsp.mjs'
  }),
  build({
    ...shared,
    entryPoints: ['server/runtime.mjs'],
    outfile: 'server/dist/maa-runtime.mjs'
  })
])
