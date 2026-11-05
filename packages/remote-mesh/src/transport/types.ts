import type { NodeDescriptor, WorkspaceSummary } from '../types.js'

/**
 * The one seam that keeps third-party integration out of the core.
 *
 * Two adapters ship: `mock` (tests) and `typert` (real cross-machine RPC over the
 * peer's own web API, see transport/typert.ts).
 */
/** One conversation line, as the peer's own log records it. */
export interface MeshSessionMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  /** Unix milliseconds from the event, when the peer recorded one. */
  time?: number
}

export interface MeshTransport {
  readonly kind: 'mock' | 'typert'
  listNodes(): Promise<NodeDescriptor[]>
  listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]>
  createSession(nodeId: string, workspaceId: string): Promise<string>
  prompt(nodeId: string, sessionId: string, text: string): Promise<void>
  /** Returns an unsubscribe function. */
  follow(nodeId: string, sessionId: string, onEvent: (event: unknown) => void): Promise<() => void>
  /**
   * Read the tail of a session log. Optional: an adapter that cannot read
   * history simply leaves it out and the UI hides the viewer.
   */
  readSession?(nodeId: string, sessionId: string, limit?: number): Promise<MeshSessionMessage[]>
}

/** What an adapter throws when it cannot do its job — never return fake data instead. */
export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}
