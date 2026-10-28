import type { MeshTransport } from './types.js'
import { TransportUnavailableError } from './types.js'

/**
 * Adapter over the runtime cordis service `remoteWebUiPairing` provided by the
 * community plugin `@linxin666/dsh-remote-web-ui`.
 *
 * Deliberately NOT an npm dependency: the service is looked up on the live ctx,
 * so this plugin keeps loading whether or not that package is installed.
 *
 * TODO(P1): confirm the real method names on the service (see SPEC §13 question 1)
 * before implementing. Until then every call fails loudly instead of silently.
 */
export function detectPairingService(ctx: unknown): unknown | undefined {
  const anyCtx = ctx as { get?: (name: string) => unknown; remoteWebUiPairing?: unknown } | undefined
  // Cordis throws when a property names a service the calling plugin did not
  // inject ("cannot get property ... without inject"), so probe defensively:
  // a missing community plugin degrades to "no transport", never to an error.
  let svc: unknown
  try {
    svc = typeof anyCtx?.get === 'function' ? anyCtx.get('remoteWebUiPairing') : anyCtx?.remoteWebUiPairing
  } catch {
    return undefined
  }
  if (!svc) return undefined
  // Feature-detect on methods, not just on the service name (SPEC §9.4).
  const probe = svc as Record<string, unknown>
  const hasAny = ['listPeers', 'peers', 'listWorkspaces'].some((k) => typeof probe[k] === 'function')
  return hasAny ? svc : undefined
}

export function createPairingTransport(): MeshTransport {
  const fail = (): never => {
    throw new TransportUnavailableError(
      'pairing transport is not implemented yet; install @linxin666/dsh-remote-web-ui and see SPEC §13',
    )
  }
  return {
    kind: 'pairing',
    listNodes: async () => fail(),
    listWorkspaces: async () => fail(),
    createSession: async () => fail(),
    prompt: async () => fail(),
    follow: async () => fail(),
  }
}
