import type { NodeDescriptor, WorkspaceSummary } from '../types.js'
import type { MeshTransport } from './types.js'

/**
 * Cross-machine transport over DSH's own Typert RPC surface (roadmap increment 1).
 *
 * Call line (measured on 0.2.1-rc.4, evidence/s0-typert-cross-machine.md §2):
 *   GET  /connect?token=<login token>&interactions=none  -> 302 + signed cookie
 *   POST /api/<namespace>/<method>  {type:'client-request', rpcId, method, payload:{args}}
 *        -> {type:'server-response', result:{ok:true,value} | {ok:false,error}}
 *
 * Only unary endpoints are used. `session/follow` and `workspace/follow` are
 * stream-carrier methods ("must be opened through the stream carrier"), so
 * `follow()` is implemented by polling `session/list` for the cursor and
 * `session/page` for the events behind it. That is a documented deviation: the
 * caller sees the same event stream, with poll-interval latency instead of
 * push latency (docs/reference/tools.md).
 *
 * Zero package dependencies: global fetch and the platform only.
 */

export interface TypertPeer {
  nodeId: string
  /** HTTP(S) root of the peer's web host, e.g. https://peer.example.com:3211 */
  baseUrl: string
  /** The peer's current web login token (`?token=`); rotates when the peer restarts. */
  token: string
}

/** One workspace this node hosts, with the directory a new session should own. */
export interface TypertWorkspaceRoute {
  workspaceId: string
  cwd: string
}

export interface TypertTransportOptions {
  peers: readonly TypertPeer[]
  /** Workspaces assignment.yml routes to a node (the transport never reads the file). */
  listAssigned?: (nodeId: string) => readonly TypertWorkspaceRoute[]
  /** Resolve one workspaceId to the node that hosts it and its remote cwd. */
  resolveWorkspace?: (workspaceId: string) => { nodeId: string; cwd: string } | undefined
  /** Poll interval for follow(), milliseconds. */
  pollMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Error carrying the mesh error code the tool layer maps onto its vocabulary. */
export class TypertRpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'TypertRpcError'
    this.code = code
  }
}

interface RpcEnvelope {
  result?: {
    ok?: boolean
    value?: unknown
    error?: { code?: string; message?: string; details?: unknown }
  }
}

interface SessionListRow {
  sessionId?: string
  running?: boolean
  cwd?: string
  updatedAt?: number
  projections?: { asOfSeq?: number; values?: { title?: string | null } }
}

interface PageRecord {
  event?: { type?: string; seq?: number; data?: unknown }
  type?: string
  seq?: number
}

const MAX_PAGE_WALK = 20

let requestCounter = 0

function nextRequestId(prefix: string): string {
  requestCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${requestCounter}`
}

/** Map a gateway error code onto the mesh vocabulary used by toMeshError(). */
function mapGatewayCode(code: string | undefined, message: string): string {
  const raw = code ?? ''
  if (/access|denied|forbidden|unauthorized/i.test(raw) || /access denied|unauthorized/i.test(message)) return 'forbidden'
  if (/unknown-session/i.test(raw)) return 'unknown-session'
  if (/unknown-workspace/i.test(raw)) return 'unknown-workspace'
  if (/timeout|aborted/i.test(raw)) return 'timeout'
  if (/arguments-invalid/i.test(raw)) return 'bad-target'
  return 'remote-failure'
}

class TypertClient {
  private cookie: string | undefined
  constructor(
    private readonly peer: TypertPeer,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private url(path: string): string {
    const base = this.peer.baseUrl.replace(/\/+$/, '')
    return `${base}${path}`
  }

  /** Exchange the login token for a signed API cookie (cached per client). */
  private async connect(): Promise<string> {
    if (this.cookie !== undefined) return this.cookie
    const target = `${this.url('/connect')}?token=${encodeURIComponent(this.peer.token)}&interactions=none`
    const res = await this.fetchImpl(target, { redirect: 'manual' })
    const cookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter((value): value is string => typeof value === 'string' && value !== '')
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    if (cookie === '') {
      throw new TypertRpcError('forbidden', `peer ${this.peer.nodeId}: /connect returned no credential (token stale?)`)
    }
    this.cookie = cookie
    return cookie
  }

  async call<T = unknown>(method: string, args: unknown): Promise<T> {
    const attempt = async (): Promise<T> => {
      const cookie = await this.connect()
      const res = await this.fetchImpl(this.url(`/api/${method}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: nextRequestId(method), method, payload: { args } }),
      })
      if (res.status === 401 || res.status === 403) {
        this.cookie = undefined
        throw new TypertRpcError('forbidden', `peer ${this.peer.nodeId}: ${method} was rejected (HTTP ${res.status}); refresh the peer token`)
      }
      if (!res.ok) {
        throw new TypertRpcError('remote-failure', `peer ${this.peer.nodeId}: ${method} returned HTTP ${res.status}`)
      }
      const envelope = (await res.json()) as RpcEnvelope
      const result = envelope.result
      if (result === undefined) {
        throw new TypertRpcError('remote-failure', `peer ${this.peer.nodeId}: ${method} returned no result envelope`)
      }
      if (result.ok !== true) {
        const code = result.error?.code
        const message = result.error?.message ?? 'peer rejected the call'
        throw new TypertRpcError(mapGatewayCode(code, message), `peer ${this.peer.nodeId}: ${message}`)
      }
      return result.value as T
    }
    try {
      return await attempt()
    } catch (err) {
      // A stale cookie is recoverable: reconnect once with the same token.
      if (err instanceof TypertRpcError && err.code === 'forbidden' && this.cookie === undefined) {
        return attempt()
      }
      throw err
    }
  }
}

export interface TypertTransport extends MeshTransport {
  readonly kind: 'typert'
}

export function createTypertTransport(options: TypertTransportOptions): TypertTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  const pollMs = options.pollMs ?? 1000
  const now = options.now ?? Date.now
  const clients = new Map<string, TypertClient>()
  for (const peer of options.peers) clients.set(peer.nodeId, new TypertClient(peer, fetchImpl))

  const requireClient = (nodeId: string): TypertClient => {
    const client = clients.get(nodeId)
    if (client === undefined) throw new TypertRpcError('unknown-node', `no peer configured for node "${nodeId}"`)
    return client
  }

  const workspacesOf = (nodeId: string): WorkspaceSummary[] =>
    (options.listAssigned?.(nodeId) ?? []).map((route) => ({
      workspaceId: route.workspaceId,
      name: route.workspaceId,
      path: route.cwd,
      sessions: [],
    }))

  /** session/list tolerates the "_request" carrier; retry once if a peer rejects it. */
  const listSessions = async (client: TypertClient): Promise<SessionListRow[]> => {
    try {
      const value = await client.call<{ items?: SessionListRow[] }>('session/list', { _request: {} })
      return value.items ?? []
    } catch (err) {
      if (err instanceof TypertRpcError && err.code === 'bad-target') {
        const value = await client.call<{ items?: SessionListRow[] }>('session/list', {})
        return value.items ?? []
      }
      throw err
    }
  }

  const findRow = (rows: SessionListRow[], sessionId: string): SessionListRow | undefined =>
    rows.find((row) => row.sessionId === sessionId)

  /** Events up to `throughSeq`, keeping only those after `sinceSeq`, oldest first. */
  const readEvents = async (
    client: TypertClient,
    sessionId: string,
    throughSeq: number,
    sinceSeq: number,
  ): Promise<Array<{ type?: string; seq: number; data?: unknown }>> => {
    const collected: Array<{ type?: string; seq: number; data?: unknown }> = []
    let through = throughSeq
    let beforeSeq: number | undefined
    for (let walk = 0; walk < MAX_PAGE_WALK; walk += 1) {
      const request: Record<string, unknown> = {
        address: { kind: 'session', sessionId },
        throughSeq: through,
        maxMessages: 200,
      }
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
      const value = await client.call<{ records?: PageRecord[]; hasMore?: boolean }>('session/page', { request })
      const events = (value.records ?? [])
        .map((record) => record.event ?? record)
        .filter((event): event is { type?: string; seq: number; data?: unknown } => typeof event.seq === 'number')
      collected.push(...events)
      if (value.hasMore !== true || events.length === 0) break
      const oldest = Math.min(...events.map((event) => event.seq))
      if (oldest <= sinceSeq + 1) break
      beforeSeq = oldest
      through = oldest
    }
    return collected.filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq)
  }

  return {
    kind: 'typert',

    async listNodes(): Promise<NodeDescriptor[]> {
      const nodes: NodeDescriptor[] = []
      for (const peer of options.peers) {
        const client = requireClient(peer.nodeId)
        let online = true
        try {
          await listSessions(client)
        } catch {
          online = false
        }
        nodes.push({
          nodeId: peer.nodeId,
          label: peer.nodeId,
          endpoint: peer.baseUrl,
          online,
          lastSeenAt: now(),
          workspaces: workspacesOf(peer.nodeId),
        })
      }
      return nodes
    },

    async listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]> {
      requireClient(nodeId)
      return workspacesOf(nodeId)
    },

    async createSession(nodeId: string, workspaceId: string): Promise<string> {
      const client = requireClient(nodeId)
      const target = options.resolveWorkspace?.(workspaceId)
      if (target === undefined) {
        throw new TypertRpcError('unknown-workspace', `workspace "${workspaceId}" has no remote cwd; add one to assignment.yml`)
      }
      if (target.nodeId !== nodeId) {
        throw new TypertRpcError('unknown-workspace', `workspace "${workspaceId}" is assigned to "${target.nodeId}", not "${nodeId}"`)
      }
      const value = await client.call<{ sessionId?: string }>('session/create', { request: { cwd: target.cwd } })
      if (typeof value.sessionId !== 'string' || value.sessionId === '') {
        throw new TypertRpcError('remote-failure', `peer ${nodeId}: session/create returned no sessionId`)
      }
      return value.sessionId
    },

    async prompt(nodeId: string, sessionId: string, text: string): Promise<void> {
      const client = requireClient(nodeId)
      await client.call('session/prompt', {
        request: {
          requestId: nextRequestId('mesh-prompt'),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      })
    },

    async follow(nodeId: string, sessionId: string, onEvent: (event: unknown) => void): Promise<() => void> {
      const client = requireClient(nodeId)
      const rows = await listSessions(client)
      const row = findRow(rows, sessionId)
      if (row === undefined) {
        throw new TypertRpcError('unknown-session', `peer ${nodeId}: session "${sessionId}" is not on this node`)
      }
      // Everything already on the log is a replacement baseline (SPEC §7.2): the
      // collector discards it and only accepts events after the boundary.
      const baselineCursor = row.projections?.asOfSeq ?? 0
      for (const event of await readEvents(client, sessionId, baselineCursor, -1)) onEvent(event)
      onEvent({ type: 'mesh/baseline/end', seq: baselineCursor })

      let lastSeq = baselineCursor
      let stopped = false
      let inflight = false
      const tick = async (): Promise<void> => {
        if (stopped || inflight) return
        inflight = true
        try {
          const nextRows = await listSessions(client)
          const nextRow = findRow(nextRows, sessionId)
          const cursor = nextRow?.projections?.asOfSeq
          if (typeof cursor === 'number' && cursor > lastSeq) {
            for (const event of await readEvents(client, sessionId, cursor, lastSeq)) {
              lastSeq = Math.max(lastSeq, event.seq)
              onEvent(event)
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          onEvent({ type: 'session/error', error: { message } })
        } finally {
          inflight = false
        }
      }
      const timer = setInterval(() => { void tick() }, pollMs)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    },
  }
}
