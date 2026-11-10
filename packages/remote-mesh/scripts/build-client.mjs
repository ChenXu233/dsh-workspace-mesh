#!/usr/bin/env node
/**
 * Bundle the browser half into the single file the DSH client module loader
 * expects (client/client.js). The host hands a plugin bundle a `require` that
 * resolves only the platform module table, so React and react-dom stay external
 * and everything else (the topology canvas) is inlined here.
 *
 * Runs as part of `pnpm build`; the output is committed because the package
 * ships it.
 */
import { build } from 'esbuild'
import { readFileSync, appendFileSync, existsSync } from 'node:fs'

const ID = 'dsh-workspace-mesh'
const OUT = 'client/client.js'
const ENTRY = 'client/src/app.js'

// The loader owns the factory: banner opens it, footer closes it, and everything
// esbuild emits in between runs inside the factory closure — that is what makes
// the generated require("react") resolve to the platform module table.
const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `
    return module.exports;
  }
});
`

// MIT requires the notices to travel with the code, and esbuild only keeps
// comments it recognises, so the bundled packages' licenses are appended here.
const BUNDLED = ['@xyflow/react', '@xyflow/system', 'zustand', 'classcat', 'd3-zoom', 'd3-selection', 'd3-drag', 'd3-interpolate', 'd3-transition', 'd3-ease', 'd3-color', 'd3-dispatch', 'd3-timer']

function licenseBlock() {
  const parts = ['', '/* ==== bundled third-party licenses ==== */']
  for (const name of BUNDLED) {
    const candidates = [`node_modules/${name}/LICENSE`, `node_modules/${name}/LICENSE.md`]
    const file = candidates.find((path) => existsSync(path))
    if (file === undefined) continue
    const text = readFileSync(file, 'utf8').trim()
    parts.push(`\n/* ---- ${name} ----\n${text}\n*/`)
  }
  return parts.join('\n') + '\n'
}

await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  external: [
    'react', 'react-dom', 'react/jsx-runtime', 'react-dom/client',
    // Served by the shell's frozen platform module table, so the bundle shares
    // the very atoms the official pages render (buttons, inputs, tags).
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  loader: { '.css': 'text' },
  legalComments: 'eof',
  logLevel: 'warning',
  banner: { js: banner },
  footer: { js: footer },
})

appendFileSync(OUT, licenseBlock())