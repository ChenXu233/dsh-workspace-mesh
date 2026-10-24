import type { NodeDescriptor, WorkspaceSummary } from '../types.js'

/** The one seam that keeps third-party integration out of the core. */
export interface MeshTransport {
  readonly kind: 'pairing' | 'loopback' | 'mock'
  listNodes(): Promise<NodeDescriptor[]>
  listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]>
  createSession(nodeId: string, workspaceId: string): Promise<string>
  prompt(nodeId: string, sessionId: string, text: string): Promise<void>
  /** Returns an unsubscribe function. */
  follow(nodeId: string, sessionId: string, onEvent: (event: unknown) => void): Promise<() => void>
}

export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}
