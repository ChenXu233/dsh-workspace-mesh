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

/**
 * One durable session event exactly as the peer's log records it.
 *
 * The conversation renderer needs the event, not a summary: roles, tool calls,
 * turn boundaries and status all come from the same event stream the peer's own
 * page reads, so the remote transcript can be assembled by the same rules.
 */
export interface MeshSessionEvent {
  seq: number
  type?: string
  time?: number
  data?: unknown
  [key: string]: unknown
}

/** One page of a peer's session log, newest events last. */
export interface MeshEventPage {
  events: MeshSessionEvent[]
  /** True when older events exist before the returned window. */
  hasMore: boolean
  /** Highest durable seq the peer had for this session when it answered. */
  endSeq?: number
  /** Whether the session was running when the peer answered. */
  running?: boolean
}

/** Which slice of one session log a caller asks for. */
/** One live Assistant frame (start, chunk, or end) retained by the owning machine. */
export interface MeshLiveFrame {
  readonly type?: string
  readonly revision?: number
  readonly attemptId?: string
  readonly index?: number
  readonly time?: number
  readonly turn?: number
  readonly step?: number
  readonly startedAfterSeq?: number
  readonly chunk?: unknown
  readonly outcome?: unknown
}

/** Everything one reader has not folded yet. */
export interface MeshLivePage {
  /** Highest revision the owning machine produced so far. */
  readonly revision: number
  /** Frames newer than the reader's revision, oldest first. */
  readonly frames: readonly MeshLiveFrame[]
}

export interface MeshEventRequest {
  /** Tail cursor; omitted means the peer's current head. */
  throughSeq?: number
  /** Page backwards from this seq (exclusive), for a follow-up page. */
  beforeSeq?: number
  /** Upper bound on returned events. */
  maxMessages?: number
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
   * Read one page of a session's raw event log.
   *
   * `readSession` flattens the log to chat lines for a summary; a conversation
   * page renders the events themselves, so it needs them verbatim. Optional for
   * the same reason as `readSession`.
   */
  readEvents?(nodeId: string, sessionId: string, request?: MeshEventRequest): Promise<MeshEventPage>
  /**
   * Read the live Assistant frames a peer retained for one Session.
   *
   * Durable events settle a turn only once it is finished; these frames are what
   * paints the answer while it is being written. Optional: without them the page
   * shows whole messages.
   */
  readAssistantLive?(nodeId: string, sessionId: string, since: number): Promise<MeshLivePage>
  /**
   * Read the tail of a session log. Optional: an adapter that cannot read
   * history simply leaves it out and the UI hides the viewer.
   */
  readSession?(nodeId: string, sessionId: string, limit?: number): Promise<MeshSessionMessage[]>
  /**
   * Peer-control round trip: browse the peer's directories, or create a
   * Workspace there.
   *
   * Deliberately outside the five-method task data plane (SPEC §6.2): these are
   * administration calls made while the user is editing the workspace list, not
   * part of how a task reaches a peer. Optional — a transport without the peer's
   * relay cannot offer them.
   */
  control?(nodeId: string, op: MeshControlOp, args: Record<string, unknown>): Promise<unknown>
}

/** Administration operations a paired peer may serve outside the task data plane. */
export type MeshControlOp = 'browse' | 'workspace-create'

/** What an adapter throws when it cannot do its job — never return fake data instead. */
export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}