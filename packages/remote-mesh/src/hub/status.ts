/**
 * The hub surface the status page and `mesh_status` read.
 *
 * It is a projection of three things that already exist — the config (which hub
 * this node joined), the registry (who is in the directory), and the agent (why
 * the last poll failed) — so a model or an operator can answer "is the domain
 * healthy" without reading logs.
 */
import type { HubNodeRecord, HubRegistry } from './registry.js'

/** One directory row with the numbers that actually diagnose a stale node. */
export interface HubNodeStatus {
  readonly nodeId: string
  readonly url: string
  /** Requests queued for this node right now. */
  readonly pending: number
  readonly lastSeenAt: number
  /** How long since this node last polled, in milliseconds. */
  readonly ageMs: number
}

/** Everything the surfaces need about this node's hub involvement. */
export interface HubStatus {
  /** 'hub' when others join this node, 'member' when it joined one, 'off' otherwise. */
  readonly role: 'hub' | 'member' | 'off'
  readonly url: string
  readonly nodeId: string
  readonly nodes: HubNodeStatus[]
  readonly pending: number
  /** Why the last join/poll failed, empty when it is healthy. */
  readonly lastError: string
}

/**
 * Build the view.
 * @param input - config, registry and the agent's last error.
 * @returns the status projection.
 */
export function hubStatus(input: {
  url: string
  nodeId: string
  registry: HubRegistry
  lastError: string
  now?: () => number
}): HubStatus {
  const now = input.now ?? Date.now
  const records: HubNodeRecord[] = input.registry.directory()
  const nodes = records.map(record => ({
    nodeId: record.nodeId,
    url: record.url,
    pending: input.registry.pending(record.nodeId),
    lastSeenAt: record.lastSeenAt,
    ageMs: Math.max(0, now() - record.lastSeenAt),
  }))
  return {
    role: input.url === '' ? 'off' : 'member',
    url: input.url,
    nodeId: input.nodeId,
    nodes,
    pending: nodes.reduce((sum, node) => sum + node.pending, 0),
    lastError: input.lastError,
  }
}
