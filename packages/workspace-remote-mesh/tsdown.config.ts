import { resolve } from 'node:path'
import { dshCssModules } from '../../build/css-modules.ts'
import { dshPackageBuild } from '../../build/tsdown.ts'

/** Module id the loader registers this bundle under; also the CSS tag owner. */
const PACKAGE = 'dsh-proton-workspace-remote-mesh'

/**
 * Modules the host's client loader already provides to every bundle.
 *
 * This is exactly the set the official `@deepseek-ai/dsh-client-ui-workspace`
 * bundle requires. Everything the official bundle inlines is inlined here too,
 * so both bundles see the same module boundaries — a module the host also
 * loads must never be duplicated, and one the official bundle owns must not be
 * shared behind its back.
 */
const HOST_MODULES = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  // The conversation assembly class is a value this bundle needs (a second
  // assembler over the shipped definitions). It must be the Host's own copy:
  // the module table word is the peer package, and `/client` is stripped when
  // the loader resolves the require.
  '@deepseek-ai/dsh-client-ui-conversation/client',
]

/** Browser-half source root: CSS tag ids are relative to it (every vendored package lives under it). */
const CLIENT_SRC = resolve(import.meta.dirname, 'vendor')

export default dshPackageBuild(PACKAGE, 'src/client/index.tsx', {
  externals: HOST_MODULES,
  plugins: [dshCssModules({ packageName: PACKAGE, rootDir: CLIENT_SRC })],
})