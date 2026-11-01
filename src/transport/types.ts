import type { NodeDescriptor, WorkspaceSummary } from '../types.js'

/**
 * The one seam that keeps third-party integration out of the core.
 *
 * Only the mock adapter ships today: the pairing probe was disproved by evidence
 * and the loopback stub never had real request shapes, so both were removed.
 * TypertTransport adds `kind: 'typert'` (docs/explanation/roadmap.md increment 1).
 */
export interface MeshTransport {
  readonly kind: 'mock'
  listNodes(): Promise<NodeDescriptor[]>
  listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]>
  createSession(nodeId: string, workspaceId: string): Promise<string>
  prompt(nodeId: string, sessionId: string, text: string): Promise<void>
  /** Returns an unsubscribe function. */
  follow(nodeId: string, sessionId: string, onEvent: (event: unknown) => void): Promise<() => void>
}

/** What an adapter throws when it cannot do its job — never return fake data instead. */
export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}
