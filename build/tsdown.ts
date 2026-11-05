import type { UserConfig } from 'tsdown'
import type { TsdownPlugin } from 'tsdown'

/** Options for the browser half of a package build. */
export interface ClientBundleOptions {
  /**
   * Modules the host already provides to every client bundle. Anything listed
   * here is emitted as `require(...)`; everything else is bundled in.
   *
   * The list is a correctness boundary, not an optimisation: a module the host
   * also loads must be shared with it, or both copies get their own React
   * context and module state.
   */
  externals?: string[]
  /** Extra rolldown plugins, applied to the browser half only. */
  plugins?: TsdownPlugin[]
}

const DEFAULT_CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']

/**
 * Build config for one DSH bundle package: a node-side entry plus a browser
 * half wrapped in the `window.__ModuleLoader__` envelope.
 *
 * @param id - module id the loader registers and resolves the bundle by.
 * @param clientEntry - source entry of the browser half.
 * @param options - client externals and plugins.
 * @returns two tsdown configs (host half, browser half).
 */
export function dshPackageBuild(
  id: string,
  clientEntry: string,
  options: ClientBundleOptions = {},
): UserConfig[] {
  const externals = options.externals ?? DEFAULT_CLIENT_EXTERNALS
  const plugins = options.plugins ?? []
  return [
    {
      entry: { index: 'src/index.ts' },
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: true,
      deps: { neverBundle: ['@deepseek-ai/cordis'] },
    },
    {
      entry: { client: clientEntry },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2024',
      dts: false,
      clean: false,
      plugins,
      deps: { neverBundle: externals },
      define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}
