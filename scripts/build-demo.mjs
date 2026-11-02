#!/usr/bin/env node
/** Bundle the local harness (not shipped). */
import { build } from 'esbuild'

await build({
  entryPoints: ['client/src/demo.jsx'],
  outfile: 'demo/demo.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
})
