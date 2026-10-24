import type { MeshTransport } from './types.js'
import { TransportUnavailableError } from './types.js'

/**
 * Fallback transport: talk to the peer's loopback embed proxy over plain HTTP.
 * Zero package dependencies — only global fetch.
 *
 * TODO(P1): capture the real request shapes from the browser devtools
 * (see SPEC §13 question 1). Until then this fails loudly.
 */
export function createLoopbackTransport(baseUrl: string): MeshTransport {
  const fail = (): never => {
    throw new TransportUnavailableError(
      `loopback transport not implemented yet (baseUrl=${baseUrl}); see SPEC §13`,
    )
  }
  return {
    kind: 'loopback',
    listNodes: async () => fail(),
    listWorkspaces: async () => fail(),
    createSession: async () => fail(),
    prompt: async () => fail(),
    follow: async () => fail(),
  }
}
