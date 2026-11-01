import type { NodeDescriptor, WorkspaceSummary } from '../types.js'
import type { MeshSessionMessage, MeshTransport } from './types.js'

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
  /** Path the peer serves its native workspace list on (default /api/mesh/workspaces). */
  workspacesPath?: string
  /**
   * How long one peer is left alone after a failed call (default 60s).
   *
   * The page polls state every few seconds; without a cooldown a stale token
   * turns into a steady stream of 401s, which is exactly what host intrusion
   * filters (fail2ban) ban an IP for.
   */
  failureCooldownMs?: number
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

/** Concatenate the text parts of a message payload, ignoring images and files. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('').trim()
}

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
    /** Called after any failure so the transport can stop hammering this peer. */
    private readonly onFailure: () => void = () => {},
    /** True while the peer is cooling down: no network call is attempted. */
    private readonly coolingDown: () => boolean = () => false,
  ) {}

  private assertNotCoolingDown(path: string): void {
    if (this.coolingDown()) {
      throw new TypertRpcError('node-offline', `peer ${this.peer.nodeId}: cooling down after a failure, ${path} skipped`)
    }
  }

  private url(path: string): string {
    const base = this.peer.baseUrl.replace(/\/+$/, '')
    return `${base}${path}`
  }

  /** Exchange the login token for a signed API cookie (cached per client). */
  private async connect(): Promise<string> {
    if (this.cookie !== undefined) return this.cookie
    this.assertNotCoolingDown('/connect')
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

  /** Authenticated GET against the peer's own routes (not the Typert RPC surface). */
  async get<T = unknown>(path: string): Promise<T> {
    this.assertNotCoolingDown(path)
    try {
      return await this.getOnce<T>(path)
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private async getOnce<T = unknown>(path: string): Promise<T> {
    const cookie = await this.connect()
    const res = await this.fetchImpl(this.url(path), { headers: { cookie, accept: 'application/json' } })
    if (res.status === 401 || res.status === 403) {
      this.cookie = undefined
      throw new TypertRpcError('forbidden', `peer ${this.peer.nodeId}: ${path} was rejected (HTTP ${res.status}); refresh the peer token`)
    }
    if (!res.ok) {
      throw new TypertRpcError('remote-failure', `peer ${this.peer.nodeId}: ${path} returned HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  async call<T = unknown>(method: string, args: unknown): Promise<T> {
    this.assertNotCoolingDown(method)
    const attempt = async (): Promise<T> => {
      const cookie = await this.connect()
      const res = await this.fetchImpl(this.url(`/api/${method}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: nextRequestId(method), method, payload: { args } }),
      })
      if (res.status === 401 || res.status === 403) {
        this.cookie = undefined
        this.onFailure()
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
      // A stale cookie is recoverable: reconnect once with the same token. The
      // retry is one call, not two failures — counting both doubled the 401 rate.
      if (err instanceof TypertRpcError && err.code === 'forbidden' && this.cookie === undefined) {
        try {
          return await attempt()
        } catch (retried) {
          this.onFailure()
          throw retried
        }
      }
      this.onFailure()
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
  const cooldownMs = options.failureCooldownMs ?? 60_000
  /** Consecutive failures before a peer is left alone; one 401 may just be a stale cookie. */
  const FAILURES_BEFORE_COOLDOWN = 2
  const blockedUntil = new Map<string, number>()
  const failureCount = new Map<string, number>()
  const coolingDown = (nodeId: string): boolean => (blockedUntil.get(nodeId) ?? 0) > now()
  const noteFailure = (nodeId: string): void => {
    const next = (failureCount.get(nodeId) ?? 0) + 1
    failureCount.set(nodeId, next)
    if (next < FAILURES_BEFORE_COOLDOWN) return
    // Exponential backoff: 60s, 120s, 240s … capped at 16x. A flat 60s window
    // still leaks two 401s a minute, which is exactly the rate an intrusion
    // filter bans an IP for; the backoff drops it to a handful per hour.
    const factor = Math.min(2 ** (next - FAILURES_BEFORE_COOLDOWN), 16)
    blockedUntil.set(nodeId, now() + cooldownMs * factor)
  }
  const noteSuccess = (nodeId: string): void => {
    failureCount.delete(nodeId)
    blockedUntil.delete(nodeId)
  }

  const clients = new Map<string, TypertClient>()
  for (const peer of options.peers) {
    clients.set(
      peer.nodeId,
      new TypertClient(peer, fetchImpl, () => noteFailure(peer.nodeId), () => coolingDown(peer.nodeId)),
    )
  }

  const requireClient = (nodeId: string): TypertClient => {
    const client = clients.get(nodeId)
    if (client === undefined) throw new TypertRpcError('unknown-node', `no peer configured for node "${nodeId}"`)
    return client
  }

  /** assignment.yml routes, used when the peer cannot report its own registry. */
  const workspacesOf = (nodeId: string): WorkspaceSummary[] =>
    (options.listAssigned?.(nodeId) ?? []).map((route) => ({
      workspaceId: route.workspaceId,
      name: route.workspaceId,
      path: route.cwd,
      sessions: [],
    }))

  const workspacesPath = options.workspacesPath ?? '/api/mesh/workspaces'
  /** Native workspace ids seen per node: the only ids the peer's session/create accepts. */
  const nativeIds = new Map<string, Set<string>>()

  const fetchNativeWorkspaces = async (client: TypertClient, nodeId: string): Promise<WorkspaceSummary[] | undefined> => {
    try {
      const payload = await client.get<{
        workspaces?: Array<{ workspaceId?: string; title?: string; path?: string; sessionIds?: string[] }>
      }>(workspacesPath)
      const items = payload.workspaces
      if (!Array.isArray(items)) return undefined
      // Titles and busy flags live on the session log, not on the registry entry.
      let rows: SessionListRow[] = []
      try {
        rows = await listSessions(client)
      } catch {
        rows = []
      }
      const byId = new Map<string, SessionListRow>()
      for (const row of rows) if (typeof row.sessionId === 'string') byId.set(row.sessionId, row)
      const ids = new Set<string>()
      const accounted = new Set<string>()
      const toSession = (sessionId: string) => {
        const row = byId.get(sessionId)
        return {
          sessionId,
          title: row?.projections?.values?.title ?? '',
          updatedAt: typeof row?.updatedAt === 'number' ? row.updatedAt : 0,
          busy: row?.running === true,
        }
      }
      const workspaces: WorkspaceSummary[] = items
        .filter((item) => typeof item.workspaceId === 'string' && item.workspaceId !== '')
        .map((item) => {
          const workspaceId = String(item.workspaceId)
          ids.add(workspaceId)
          const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : []
          for (const sessionId of sessionIds) accounted.add(sessionId)
          return {
            workspaceId,
            name: item.title !== undefined && item.title !== '' ? item.title : workspaceId,
            path: item.path ?? '',
            sessions: sessionIds.map(toSession),
          }
        })

      // A DSH registry only accounts Sessions created *into* a Workspace; anything
      // created by path (or before the Workspace existed) stays ungrouped. Those
      // are the user's old conversations — they must not disappear, so they are
      // grouped by their cwd, and a cwd that matches a Workspace joins it.
      const byCwd = new Map<string, string[]>()
      for (const row of rows) {
        const sessionId = row.sessionId
        if (typeof sessionId !== 'string' || accounted.has(sessionId)) continue
        const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : ''
        const list = byCwd.get(cwd)
        if (list === undefined) byCwd.set(cwd, [sessionId])
        else list.push(sessionId)
      }
      for (const [cwd, sessionIds] of byCwd) {
        const owner = workspaces.find((workspace) => cwd !== '' && workspace.path === cwd)
        if (owner !== undefined) {
          const seen = new Set(owner.sessions.map((session) => session.sessionId))
          for (const sessionId of sessionIds) if (!seen.has(sessionId)) owner.sessions.push(toSession(sessionId))
          continue
        }
        // No registered Workspace backs this directory: expose it as its own group
        // so every conversation on the peer is reachable, newest first.
        const pseudoId = cwd === '' ? 'cwd:' : `cwd:${cwd}`
        ids.add(pseudoId)
        workspaces.push({
          workspaceId: pseudoId,
          name: cwd === '' ? '(no workspace)' : cwd.split('/').filter(Boolean).pop() ?? cwd,
          path: cwd,
          sessions: sessionIds.map(toSession),
        })
      }
      for (const workspace of workspaces) {
        workspace.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      }
      nativeIds.set(nodeId, ids)
      noteSuccess(nodeId)
      return workspaces
    } catch {
      return undefined
    }
  }

  const resolveWorkspaces = async (nodeId: string): Promise<WorkspaceSummary[]> => {
    const client = requireClient(nodeId)
    const native = await fetchNativeWorkspaces(client, nodeId)
    return native ?? workspacesOf(nodeId)
  }

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
        let workspaces = workspacesOf(peer.nodeId)
        try {
          await listSessions(client)
          workspaces = (await fetchNativeWorkspaces(client, peer.nodeId)) ?? workspaces
        } catch {
          online = false
        }
        nodes.push({
          nodeId: peer.nodeId,
          label: peer.nodeId,
          endpoint: peer.baseUrl,
          online,
          lastSeenAt: now(),
          workspaces,
        })
      }
      return nodes
    },

    async listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]> {
      return resolveWorkspaces(nodeId)
    },

    async createSession(nodeId: string, workspaceId: string): Promise<string> {
      const client = requireClient(nodeId)
      // A native workspace id is the peer's own identity for the directory: use it
      // directly so the session lands in the workspace the user picked.
      let native = nativeIds.get(nodeId)?.has(workspaceId) ?? false
      if (!native && nativeIds.get(nodeId) === undefined) {
        const listed = await fetchNativeWorkspaces(client, nodeId)
        native = listed?.some((item) => item.workspaceId === workspaceId) ?? false
      }
      if (native) {
        const created = await client.call<{ sessionId?: string }>('session/create', { request: { workspaceId } })
        if (typeof created.sessionId !== 'string' || created.sessionId === '') {
          throw new TypertRpcError('remote-failure', `peer ${nodeId}: session/create returned no sessionId`)
        }
        return created.sessionId
      }
      if (workspaceId.startsWith('cwd:')) {
        // Grouped by directory rather than by a registered Workspace: create the
        // session in that directory, which is what DSH itself does for ungrouped
        // conversations.
        const cwd = workspaceId.slice('cwd:'.length)
        const created = await client.call<{ sessionId?: string }>('session/create', { request: cwd === '' ? {} : { cwd } })
        if (typeof created.sessionId !== 'string' || created.sessionId === '') {
          throw new TypertRpcError('remote-failure', `peer ${nodeId}: session/create returned no sessionId`)
        }
        return created.sessionId
      }
      const target = options.resolveWorkspace?.(workspaceId)
      if (target === undefined) {
        throw new TypertRpcError('unknown-workspace', `workspace "${workspaceId}" is not a native workspace on "${nodeId}" and has no remote cwd; add it to assignment.yml`)
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

    async readSession(nodeId: string, sessionId: string, limit = 50): Promise<MeshSessionMessage[]> {
      const client = requireClient(nodeId)
      const rows = await listSessions(client)
      const row = findRow(rows, sessionId)
      if (row === undefined) {
        throw new TypertRpcError('unknown-session', `peer ${nodeId}: session "${sessionId}" is not on this node`)
      }
      const cursor = row.projections?.asOfSeq ?? 0
      if (cursor === 0) return []
      const value = await client.call<{ records?: PageRecord[] }>('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: Math.max(1, Math.min(limit, 200)) },
      })
      const messages: MeshSessionMessage[] = []
      for (const record of value.records ?? []) {
        const event = record.event ?? record
        const type = typeof event.type === 'string' ? event.type : ''
        const seq = typeof event.seq === 'number' ? event.seq : -1
        if (seq < 0) continue
        const data = (event as { data?: unknown }).data as Record<string, unknown> | undefined
        const time = typeof (event as { time?: unknown }).time === 'number' ? (event as { time: number }).time : undefined
        if (type === 'user/message') {
          const text = partsToText(data?.content)
          if (text !== '') messages.push({ seq, role: 'user', text, ...(time === undefined ? {} : { time }) })
        } else if (type === 'assistant/message') {
          const message = data?.message as Record<string, unknown> | undefined
          const text = partsToText(message?.content)
          if (text !== '') messages.push({ seq, role: 'assistant', text, ...(time === undefined ? {} : { time }) })
        }
      }
      return messages.sort((a, b) => a.seq - b.seq)
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
