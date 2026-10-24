import type { NodeDescriptor, SessionSummary, WorkspaceSummary } from '../types.js'
import type { MeshTransport } from './types.js'

/** One method of the transport surface; used for call logging and fault injection. */
export type MockMethod = 'listNodes' | 'listWorkspaces' | 'createSession' | 'prompt' | 'follow'

export interface MockSessionSeed {
  sessionId: string
  title?: string
  updatedAt?: number
  busy?: boolean
}

/** Workspace metadata only — the mock never models file contents (SPEC §5.2). */
export interface MockWorkspaceSeed {
  workspaceId: string
  name?: string
  path?: string
  sessions?: MockSessionSeed[]
}

export interface MockNodeSeed {
  nodeId: string
  label?: string
  endpoint?: string
  online?: boolean
  lastSeenAt?: number
  workspaces?: MockWorkspaceSeed[]
}

export interface MockFaultSpec {
  /** Error code surfaced on the thrown MockTransportError. Defaults to 'injected-fault'. */
  code?: string
  message?: string
  /**
   * How many calls fail before the fault clears itself. Defaults to Infinity, i.e. the
   * fault stays armed until clearFault() is called.
   */
  times?: number
}

export interface MockPromptContext {
  nodeId: string
  sessionId: string
  text: string
  /** Zero-based prompt index within the session. */
  index: number
}

export interface MockTransportOptions {
  nodes?: readonly MockNodeSeed[]
  /** Injected clock, used only for reported timestamps — never for scheduling. Defaults to Date.now. */
  now?: () => number
  /** Faults armed before the first call, keyed by method. */
  faults?: Partial<Record<MockMethod, MockFaultSpec>>
  /** Scripted replies: whatever this returns is recorded and delivered to live followers. */
  autoRespond?: (ctx: MockPromptContext) => readonly unknown[]
  /** Session id prefix; ids are `<prefix>-<n>` from a per-transport counter. Defaults to 'mock-sess'. */
  sessionIdPrefix?: string
  /** Replay recorded events to every new follower (SPEC §7.2 replacement baseline). Defaults to true. */
  replayOnFollow?: boolean
}

export interface MockCall {
  method: MockMethod
  args: readonly unknown[]
  at: number
}

export class MockTransportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MockTransportError'
    this.code = code
  }
}

/**
 * The mock transport plus the deterministic control surface tests need.
 * It is a plain in-memory object: no sockets, no timers, no imports beyond ./types.js
 * and ../types.js (SPEC §8, §9.4). Every call completes synchronously inside the
 * returned promise, so tests never race a scheduler.
 */
export interface MockTransport extends MeshTransport {
  readonly kind: 'mock'
  /** Add or replace a node; replacing a node drops its previously created sessions. */
  addNode(seed: MockNodeSeed): void
  setOnline(nodeId: string, online: boolean): void
  hasNode(nodeId: string): boolean
  /** Queue events for a session: delivered to live followers now, replayed to later ones. */
  scriptEvents(nodeId: string, sessionId: string, events: readonly unknown[]): void
  emit(nodeId: string, sessionId: string, event: unknown): void
  /** Arm a fault for the next call(s) of one method. */
  failNext(method: MockMethod, spec?: MockFaultSpec): void
  clearFault(method: MockMethod): void
  calls(method?: MockMethod): readonly MockCall[]
  /** Full recorded event history of a session, oldest first. */
  sessionEvents(nodeId: string, sessionId: string): readonly unknown[]
  prompts(nodeId: string, sessionId: string): readonly string[]
  followerCount(nodeId: string, sessionId: string): number
}

interface NodeState {
  nodeId: string
  label: string
  endpoint: string
  online: boolean
  lastSeenAt: number
  workspaces: WorkspaceSummary[]
}

interface SessionState {
  nodeId: string
  sessionId: string
  workspaceId: string
  prompts: string[]
  events: unknown[]
  followers: Set<(event: unknown) => void>
}

interface ArmedFault {
  code: string
  message: string
  times: number
}

function cloneWorkspaces(list: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return list.map((w) => ({ ...w, sessions: w.sessions.map((s) => ({ ...s })) }))
}

function toDescriptor(node: NodeState): NodeDescriptor {
  return {
    nodeId: node.nodeId,
    label: node.label,
    endpoint: node.endpoint,
    online: node.online,
    lastSeenAt: node.lastSeenAt,
    workspaces: cloneWorkspaces(node.workspaces),
  }
}

function normalizeWorkspace(seed: MockWorkspaceSeed, stamp: number): WorkspaceSummary {
  return {
    workspaceId: seed.workspaceId,
    name: seed.name ?? seed.workspaceId,
    path: seed.path ?? `/mock/${seed.workspaceId}`,
    sessions: (seed.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      title: s.title ?? s.sessionId,
      updatedAt: s.updatedAt ?? stamp,
      busy: s.busy ?? false,
    })),
  }
}

/**
 * Create a deterministic, network-free MeshTransport (SPEC §9.4.2 seam).
 * Used by the test suite and by the P2 smoke path so dispatch can be driven
 * end-to-end without a paired peer.
 */
export function createMockTransport(options: MockTransportOptions = {}): MockTransport {
  const now = options.now ?? Date.now
  const prefix = options.sessionIdPrefix ?? 'mock-sess'
  const replayOnFollow = options.replayOnFollow ?? true
  const nodes = new Map<string, NodeState>()
  const sessions = new Map<string, SessionState>()
  const faults = new Map<MockMethod, ArmedFault>()
  const log: MockCall[] = []
  let sessionCounter = 0

  const sessionKey = (nodeId: string, sessionId: string): string => `${nodeId}\u0000${sessionId}`

  const requireNode = (nodeId: string): NodeState => {
    const node = nodes.get(nodeId)
    if (!node) throw new MockTransportError('unknown-node', `mock transport has no node "${nodeId}"`)
    return node
  }

  const requireOnline = (nodeId: string): NodeState => {
    const node = requireNode(nodeId)
    if (!node.online) throw new MockTransportError('node-offline', `node "${nodeId}" is offline`)
    return node
  }

  const requireSession = (nodeId: string, sessionId: string): SessionState => {
    const session = sessions.get(sessionKey(nodeId, sessionId))
    if (!session) {
      throw new MockTransportError(
        'unknown-session',
        `mock transport has no session "${sessionId}" on node "${nodeId}"`,
      )
    }
    return session
  }

  /** Record the call first so injected faults are still visible in the call log. */
  const guard = (method: MockMethod, args: readonly unknown[]): void => {
    log.push({ method, args, at: now() })
    const fault = faults.get(method)
    if (!fault) return
    fault.times -= 1
    if (fault.times <= 0) faults.delete(method)
    throw new MockTransportError(fault.code, fault.message)
  }

  const armFault = (method: MockMethod, spec: MockFaultSpec = {}): void => {
    faults.set(method, {
      code: spec.code ?? 'injected-fault',
      message: spec.message ?? `injected ${method} fault`,
      times: spec.times ?? Number.POSITIVE_INFINITY,
    })
  }

  const deliver = (session: SessionState, event: unknown): void => {
    session.events.push(event)
    // Snapshot: a listener that unsubscribes during delivery must not disturb this round.
    for (const listener of [...session.followers]) listener(event)
  }

  const addNode = (seed: MockNodeSeed): void => {
    const stamp = now()
    // Replacing a node invalidates the sessions it used to host.
    for (const [key, session] of sessions) {
      if (session.nodeId === seed.nodeId) sessions.delete(key)
    }
    const workspaces = (seed.workspaces ?? []).map((w) => normalizeWorkspace(w, stamp))
    const state: NodeState = {
      nodeId: seed.nodeId,
      label: seed.label ?? seed.nodeId,
      endpoint: seed.endpoint ?? `mock://${seed.nodeId}`,
      online: seed.online ?? true,
      lastSeenAt: seed.lastSeenAt ?? stamp,
      workspaces,
    }
    nodes.set(state.nodeId, state)
    for (const workspace of workspaces) {
      for (const summary of workspace.sessions) {
        sessions.set(sessionKey(state.nodeId, summary.sessionId), {
          nodeId: state.nodeId,
          sessionId: summary.sessionId,
          workspaceId: workspace.workspaceId,
          prompts: [],
          events: [],
          followers: new Set(),
        })
      }
    }
  }

  for (const [method, spec] of Object.entries(options.faults ?? {})) {
    if (spec) armFault(method as MockMethod, spec)
  }
  for (const seed of options.nodes ?? []) addNode(seed)

  return {
    kind: 'mock',

    async listNodes() {
      guard('listNodes', [])
      return [...nodes.values()].map(toDescriptor)
    },

    async listWorkspaces(nodeId) {
      guard('listWorkspaces', [nodeId])
      return cloneWorkspaces(requireNode(nodeId).workspaces)
    },

    async createSession(nodeId, workspaceId) {
      guard('createSession', [nodeId, workspaceId])
      const node = requireOnline(nodeId)
      const workspace = node.workspaces.find((w) => w.workspaceId === workspaceId)
      if (!workspace) {
        throw new MockTransportError(
          'unknown-workspace',
          `workspace "${workspaceId}" is not hosted on node "${nodeId}"`,
        )
      }
      sessionCounter += 1
      const sessionId = `${prefix}-${sessionCounter}`
      const summary: SessionSummary = {
        sessionId,
        title: `mock session ${sessionCounter}`,
        updatedAt: now(),
        busy: false,
      }
      workspace.sessions.push(summary)
      sessions.set(sessionKey(nodeId, sessionId), {
        nodeId,
        sessionId,
        workspaceId,
        prompts: [],
        events: [],
        followers: new Set(),
      })
      return sessionId
    },

    async prompt(nodeId, sessionId, text) {
      guard('prompt', [nodeId, sessionId, text])
      requireOnline(nodeId)
      const session = requireSession(nodeId, sessionId)
      session.prompts.push(text)
      const respond = options.autoRespond
      if (!respond) return
      for (const reply of respond({ nodeId, sessionId, text, index: session.prompts.length - 1 })) {
        deliver(session, reply)
      }
    },

    async follow(nodeId, sessionId, onEvent) {
      guard('follow', [nodeId, sessionId])
      requireOnline(nodeId)
      const session = requireSession(nodeId, sessionId)
      let active = true
      const listener = (event: unknown): void => {
        if (active) onEvent(event)
      }
      session.followers.add(listener)
      // Replacement baseline, exactly like a real reconnect (SPEC §7.2): history first,
      // then live events. No deltas are invented for the gap.
      if (replayOnFollow) {
        for (const event of [...session.events]) listener(event)
      }
      return () => {
        if (!active) return
        active = false
        session.followers.delete(listener)
      }
    },

    addNode,

    setOnline(nodeId, online) {
      const node = requireNode(nodeId)
      node.online = online
      node.lastSeenAt = now()
    },

    hasNode(nodeId) {
      return nodes.has(nodeId)
    },

    scriptEvents(nodeId, sessionId, events) {
      const session = requireSession(nodeId, sessionId)
      for (const event of events) deliver(session, event)
    },

    emit(nodeId, sessionId, event) {
      deliver(requireSession(nodeId, sessionId), event)
    },

    failNext(method, spec) {
      armFault(method, spec)
    },

    clearFault(method) {
      faults.delete(method)
    },

    calls(method) {
      return method ? log.filter((call) => call.method === method) : [...log]
    },

    sessionEvents(nodeId, sessionId) {
      return [...requireSession(nodeId, sessionId).events]
    },

    prompts(nodeId, sessionId) {
      return [...requireSession(nodeId, sessionId).prompts]
    },

    followerCount(nodeId, sessionId) {
      return requireSession(nodeId, sessionId).followers.size
    },
  }
}
