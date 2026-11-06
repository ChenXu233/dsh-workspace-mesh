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
  /** Whether the last transport receipt called the owner online. */
  readonly online: boolean
}

/** Stable identity for a remote row; also its group key in the list. */
export function remoteWorkspaceKey(row: RemoteWorkspaceRow): string {
  return 'remote:' + row.nodeId + ':' + row.workspaceId
}

const EMPTY: readonly RemoteWorkspaceRow[] = []
let rows: readonly RemoteWorkspaceRow[] = EMPTY
let signature = ''
let lastFetch = 0
let fetching = false
let listening = false
const listeners = new Set<() => void>()

/**
 * Minimum gap between snapshot reads.
 *
 * /api/mesh/state fans out to every peer (registry + session list), so an idle
 * timer here would repeat that cost for everyone on a screen nobody touched —
 * the same reason the settings page reads it on demand instead of polling.
 * Mount, focus, and becoming visible are user-driven and bounded by this gap.
 */
const MIN_GAP_MS = 30_000

function publish(next: readonly RemoteWorkspaceRow[]): void {
  const nextSignature = JSON.stringify(next)
  if (nextSignature === signature) return
  signature = nextSignature
  rows = next.length === 0 ? EMPTY : next
  for (const listener of [...listeners]) listener()
}

interface PeerWorkspaceWire {
  workspaceId?: unknown
  name?: unknown
  path?: unknown
  sessions?: unknown
}

interface PeerWire {
  nodeId?: unknown
  label?: unknown
  online?: unknown
  workspaces?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Project the mesh snapshot into rows. Only peers that actually published a
 * workspace directory qualify: a configured assignment without a workspace
 * receipt names a target this list cannot draw yet.
 * @param payload - the /api/mesh/state body (untrusted shape).
 * @returns rows in a stable, transport-independent order.
 */
export function projectRemoteWorkspaces(payload: unknown): RemoteWorkspaceRow[] {
  if (payload === null || typeof payload !== 'object') return []
  const peers = (payload as { peers?: unknown }).peers
  if (!Array.isArray(peers)) return []
  const projected: RemoteWorkspaceRow[] = []
  for (const raw of peers as PeerWire[]) {
    if (raw === null || typeof raw !== 'object') continue
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
      projected.push({
        nodeId,
        nodeLabel: label,
        workspaceId,
        title: text(item.name),
        remotePath,
        sessions: typeof item.sessions === 'number' ? item.sessions : 0,
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

async function refresh(signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch('/api/mesh/state', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    })
    if (!response.ok) return
    publish(projectRemoteWorkspaces(await response.json()))
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
