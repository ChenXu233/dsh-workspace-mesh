/**
 * Workspaces that live on another machine, as the browser draws them.
 *
 * This is the remote half of the workspace list: it reads the mesh snapshot the
 * Host already publishes for its settings page and projects each peer's
 * workspaces into rows. Nothing here creates a local Workspace record or a local
 * directory -- a remote Workspace exists only on the machine that owns it, and
 * this module is a view over that fact.
 *
 * React discipline: subscribe and getSnapshot are module constants, and the
 * snapshot keeps its identity unless the projection really changed. A fresh pair
 * per render, or a rebuilt array on every poll, turns the browser's list into an
 * unbounded render loop.
 */
import { useSyncExternalStore } from 'react'

/** One Workspace owned by a peer node. */
export interface RemoteWorkspaceRow {
  readonly nodeId: string
  /** Operator-facing node name; falls back to the id. */
  readonly nodeLabel: string
  readonly workspaceId: string
  readonly title: string
  /** Absolute directory on the owning machine. */
  readonly remotePath: string
  /** Session slots the owning registry reports; this Host holds none of them. */
  readonly sessions: number
  /** Those Sessions as the owning machine summarizes them; read-only on this Host. */
  readonly sessionRows: readonly RemoteSessionRow[]
  /** Whether the last transport receipt called the owner online. */
  readonly online: boolean
}

/** One Session the owning machine reports inside a remote Workspace. */
export interface RemoteSessionRow {
  readonly sessionId: string
  readonly title: string
  /** Epoch ms of the last update on the owning machine; 0 when it did not say. */
  readonly updatedAt: number
  /** The Session is running work on its own machine. */
  readonly busy: boolean
}

/** One peer node the remote section can talk to. */
export interface RemoteNodeRow {
  readonly nodeId: string
  readonly label: string
  readonly online: boolean
  /** How many Workspaces the node already published. */
  readonly workspaces: number
}

/** One directory listing a peer answered with. */
export interface RemoteBrowseListing {
  readonly path: string
  readonly parent: string | null
  readonly entries: ReadonlyArray<{ name: string; path: string }>
}

/** Stable identity for a remote row; also its group key in the list. */
export function remoteWorkspaceKey(row: RemoteWorkspaceRow): string {
  return 'remote:' + row.nodeId + ':' + row.workspaceId
}

const EMPTY_ROWS: readonly RemoteWorkspaceRow[] = []
const EMPTY_NODES: readonly RemoteNodeRow[] = []
let rows: readonly RemoteWorkspaceRow[] = EMPTY_ROWS
let nodes: readonly RemoteNodeRow[] = EMPTY_NODES
let signature = ''
let lastFetch = 0
let fetching = false
let listening = false
const listeners = new Set<() => void>()

/**
 * Minimum gap between snapshot reads.
 *
 * /api/mesh/state fans out to every peer (registry + session list), so an idle
 * timer here would repeat that cost for everyone on a screen nobody touched --
 * the same reason the settings page reads it on demand instead of polling.
 * Mount, focus, and becoming visible are user-driven and bounded by this gap.
 */
const MIN_GAP_MS = 30_000

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

interface PeerWorkspaceWire {
  workspaceId?: unknown
  name?: unknown
  path?: unknown
  sessions?: unknown
  /** Session summaries the peer's own transport already collected. */
  sessionList?: unknown
}

interface PeerWire {
  nodeId?: unknown
  label?: unknown
  online?: unknown
  workspaces?: unknown
}

function peersOf(payload: unknown): PeerWire[] {
  if (payload === null || typeof payload !== 'object') return []
  const peers = (payload as { peers?: unknown }).peers
  if (!Array.isArray(peers)) return []
  return (peers as PeerWire[]).filter((peer): peer is PeerWire => peer !== null && typeof peer === 'object')
}

/**
 * Read one peer's Session summaries. The peer already reduced them to
 * `{ sessionId, title, updatedAt, busy }`; anything else is dropped rather than
 * guessed at, so a malformed entry costs a row and never a broken list.
 * @param value - the wire field, untrusted.
 * @returns summaries newest first, as the owner ordered them.
 */
export function sessionRowsOf(value: unknown): RemoteSessionRow[] {
  if (!Array.isArray(value)) return []
  const rows: RemoteSessionRow[] = []
  for (const item of value as Array<Record<string, unknown> | null>) {
    if (item === null || typeof item !== 'object') continue
    const sessionId = text(item.sessionId)
    if (sessionId === '') continue
    rows.push({
      sessionId,
      title: text(item.title),
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      busy: item.busy === true,
    })
  }
  return rows
}

/**
 * Project the mesh snapshot into rows. Only peers that actually published a
 * workspace directory qualify: a configured assignment without a workspace
 * receipt names a target this list cannot draw yet.
 * @param payload - the /api/mesh/state body (untrusted shape).
 * @returns rows in a stable, transport-independent order.
 */
export function projectRemoteWorkspaces(payload: unknown): RemoteWorkspaceRow[] {
  const projected: RemoteWorkspaceRow[] = []
  for (const raw of peersOf(payload)) {
    const nodeId = text(raw.nodeId)
    if (nodeId === '') continue
    const label = text(raw.label) || nodeId
    const online = raw.online === true
    if (!Array.isArray(raw.workspaces)) continue
    for (const item of raw.workspaces as PeerWorkspaceWire[]) {
      if (item === null || typeof item !== 'object') continue
      const workspaceId = text(item.workspaceId)
      const remotePath = text(item.path)
      if (workspaceId === '' || remotePath === '') continue
      const sessionRows = sessionRowsOf(item.sessionList)
      projected.push({
        nodeId,
        nodeLabel: label,
        workspaceId,
        title: text(item.name),
        remotePath,
        sessions: typeof item.sessions === 'number' ? item.sessions : sessionRows.length,
        sessionRows,
        online,
      })
    }
  }
  projected.sort((left, right) => (
    left.nodeLabel.localeCompare(right.nodeLabel)
    || left.remotePath.localeCompare(right.remotePath)
    || left.workspaceId.localeCompare(right.workspaceId)
  ))
  return projected
}

/**
 * Project the peer nodes of the same snapshot. The adding flow needs the nodes
 * even when they publish no Workspace yet.
 * @param payload - the /api/mesh/state body.
 * @returns nodes in label order.
 */
export function projectRemoteNodes(payload: unknown): RemoteNodeRow[] {
  const projected: RemoteNodeRow[] = []
  for (const raw of peersOf(payload)) {
    const nodeId = text(raw.nodeId)
    if (nodeId === '') continue
    projected.push({
      nodeId,
      label: text(raw.label) || nodeId,
      online: raw.online === true,
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.length : 0,
    })
  }
  projected.sort((left, right) => left.label.localeCompare(right.label) || left.nodeId.localeCompare(right.nodeId))
  return projected
}

function publish(payload: unknown): void {
  const nextRows = projectRemoteWorkspaces(payload)
  const nextNodes = projectRemoteNodes(payload)
  const nextSignature = JSON.stringify([nextRows, nextNodes])
  if (nextSignature === signature) return
  signature = nextSignature
  rows = nextRows.length === 0 ? EMPTY_ROWS : nextRows
  nodes = nextNodes.length === 0 ? EMPTY_NODES : nextNodes
  for (const listener of [...listeners]) listener()
}

async function refresh(signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch('/api/mesh/state', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    })
    if (!response.ok) return
    publish(await response.json())
  } catch {
    // A missing snapshot is not an error here: the list simply has no remote
    // half until the Host answers again.
  }
}

/** One controller for the module lifetime; the list never outlives the page. */
const controller = typeof AbortController === 'function' ? new AbortController() : undefined

/**
 * Read the snapshot, at most once per {@link MIN_GAP_MS}. A fetch already in
 * flight owns the turn: overlapping reads would only repeat the fan-out.
 */
function request(): void {
  if (fetching) return
  const now = Date.now()
  if (now - lastFetch < MIN_GAP_MS) return
  lastFetch = now
  fetching = true
  void refresh(controller?.signal ?? new AbortController().signal).finally(() => { fetching = false })
}

/**
 * Read the snapshot now, ignoring the gap. Called after this Host changed
 * something on a peer, where waiting for the next wake-up would look broken.
 */
export function refreshRemoteWorkspaces(): void {
  lastFetch = 0
  request()
}

/** The page came back into view or the window regained focus. */
function onWake(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  request()
}

function startListening(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('focus', onWake)
  document.addEventListener('visibilitychange', onWake)
}

function stopListening(): void {
  if (!listening || typeof window === 'undefined') return
  listening = false
  window.removeEventListener('focus', onWake)
  document.removeEventListener('visibilitychange', onWake)
}

/** Read on first subscriber, then only when the page is brought back. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  if (listeners.size === 1) {
    startListening()
    request()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopListening()
  }
}

const getSnapshot = (): readonly RemoteWorkspaceRow[] => rows
const getNodes = (): readonly RemoteNodeRow[] => nodes

/**
 * The remote half of the workspace list.
 *
 * The vendored browser calls this; the module is the seam, exactly like a store
 * the official browser would have received through its kit.
 * @returns rows owned by peer nodes, in a stable order.
 */
export function useRemoteWorkspaces(): readonly RemoteWorkspaceRow[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Peer nodes the adding flow can target.
 * @returns nodes in label order.
 */
export function useRemoteNodes(): readonly RemoteNodeRow[] {
  return useSyncExternalStore(subscribe, getNodes, getNodes)
}

interface RemoteCallResult { ok?: boolean; value?: unknown; error?: string; code?: string }

/** One administration round trip through this Host to a peer. */
async function callRemote(op: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch('/api/mesh/remote', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ op, ...body }),
  })
  const payload = (await response.json().catch(() => undefined)) as RemoteCallResult | undefined
  if (payload === undefined) throw new Error(`peer administration failed (HTTP ${String(response.status)})`)
  if (payload.ok !== true) throw new Error(payload.error ?? `peer administration failed (HTTP ${String(response.status)})`)
  return payload.value
}

/**
 * List the directories below one path on a peer.
 * @param nodeId - the peer to ask.
 * @param path - absolute directory on that machine; empty asks for its root.
 * @returns the canonical directory and its subdirectories.
 */
export async function browseRemote(nodeId: string, path: string): Promise<RemoteBrowseListing> {
  const value = await callRemote('browse', { nodeId, path })
  const listing = value as Partial<RemoteBrowseListing> | undefined
  if (listing === undefined || typeof listing.path !== 'string' || !Array.isArray(listing.entries)) {
    throw new Error('peer answered with an unexpected directory listing')
  }
  return {
    path: listing.path,
    parent: typeof listing.parent === 'string' ? listing.parent : null,
    entries: listing.entries as Array<{ name: string; path: string }>,
  }
}

/**
 * Register a directory as a Workspace on the machine that owns it, then read the
 * snapshot again so the row appears.
 * @param nodeId - the peer that owns the directory.
 * @param path - absolute directory on that machine.
 * @param title - display name; the peer falls back to the directory name.
 * @returns whatever the peer registry returned.
 */
export async function createRemoteWorkspace(nodeId: string, path: string, title: string): Promise<unknown> {
  const value = await callRemote('workspace-create', { nodeId, path, title })
  refreshRemoteWorkspaces()
  return value
}
