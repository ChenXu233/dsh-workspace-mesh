import type { NodeDescriptor } from '../types.js'
import type { MeshToolRuntime } from '../tools/types.js'
import { workspaceViews } from '../tools/types.js'
import { toMeshError } from '../tools/protocol.js'

/**
 * Peer derivation shared by the mesh_list_nodes tool and the settings page
 * state route: assignment.yml entries and transport receipts merged into one
 * roster. Nothing here calls a DSH core roster API — there is none (spike
 * p1 §2.3) — so a node without a receipt stays "unknown" instead of online.
 */

export type PeerStatus = 'online' | 'offline' | 'unknown'
export type PeerSource = 'assignment' | 'transport' | 'both'

export interface PeerWorkspaceView {
  workspaceId: string
  name: string
  path: string
  sessions: number
}

export interface PeerView {
  nodeId: string
  label: string
  endpoint: string
  status: PeerStatus
  source: PeerSource
  lastSeenAt?: number
  workspaces: PeerWorkspaceView[]
  assignedWorkspaceIds: string[]
}

export interface RosterSnapshot {
  peers: PeerView[]
  notes: string[]
}

export function assignmentIndex(runtime: MeshToolRuntime): Map<string, string[]> {
  const assigned = new Map<string, string[]>()
  for (const route of runtime.assignment?.assignments ?? []) {
    const list = assigned.get(route.nodeId)
    if (list === undefined) assigned.set(route.nodeId, [route.workspaceId])
    else list.push(route.workspaceId)
  }
  return assigned
}

export function seedFromAssignment(
  runtime: MeshToolRuntime,
  assigned: Map<string, string[]>,
): Map<string, PeerView> {
  const peers = new Map<string, PeerView>()
  for (const node of runtime.assignment?.nodes ?? []) {
    peers.set(node.nodeId, {
      nodeId: node.nodeId,
      label: node.label ?? '',
      endpoint: node.endpoint ?? '',
      status: 'unknown',
      source: 'assignment',
      workspaces: [],
      assignedWorkspaceIds: assigned.get(node.nodeId) ?? [],
    })
  }
  // A route may name a node that has no explicit nodes: entry; keep it visible as unknown.
  for (const route of runtime.assignment?.assignments ?? []) {
    if (peers.has(route.nodeId)) continue
    peers.set(route.nodeId, {
      nodeId: route.nodeId,
      label: '',
      endpoint: '',
      status: 'unknown',
      source: 'assignment',
      workspaces: [],
      assignedWorkspaceIds: assigned.get(route.nodeId) ?? [],
    })
  }
  return peers
}

export function mergeDescriptor(peer: PeerView, descriptor: NodeDescriptor): void {
  if (peer.label === '') peer.label = descriptor.label
  if (peer.endpoint === '') peer.endpoint = descriptor.endpoint
  peer.status = descriptor.online ? 'online' : 'offline'
  peer.source = 'both'
  peer.workspaces = workspaceViews(descriptor.workspaces)
  peer.lastSeenAt = descriptor.lastSeenAt
}

/** Wire shape consumed by the model tool and the settings page. */
export function wirePeer(peer: PeerView): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    nodeId: peer.nodeId,
    label: peer.label === '' ? peer.nodeId : peer.label,
    endpoint: peer.endpoint,
    online: peer.status === 'online',
    status: peer.status,
    source: peer.source,
    workspaces: peer.workspaces,
    assignedWorkspaceIds: peer.assignedWorkspaceIds,
  }
  if (peer.lastSeenAt !== undefined) wire.lastSeenAt = peer.lastSeenAt
  return wire
}

/** Merge assignment.yml with transport receipts. Never throws: a failing transport becomes a note. */
export async function deriveRoster(runtime: MeshToolRuntime): Promise<RosterSnapshot> {
  const notes: string[] = []
  const assigned = assignmentIndex(runtime)
  const peers = seedFromAssignment(runtime, assigned)

  if (runtime.transport === undefined) {
    notes.push('no transport configured; node status is unknown')
    return { peers: [...peers.values()], notes }
  }

  try {
    for (const descriptor of await runtime.transport.listNodes()) {
      const existing = peers.get(descriptor.nodeId)
      if (existing === undefined) {
        peers.set(descriptor.nodeId, {
          nodeId: descriptor.nodeId,
          label: descriptor.label,
          endpoint: descriptor.endpoint,
          status: descriptor.online ? 'online' : 'offline',
          source: 'transport',
          lastSeenAt: descriptor.lastSeenAt,
          workspaces: workspaceViews(descriptor.workspaces),
          assignedWorkspaceIds: assigned.get(descriptor.nodeId) ?? [],
        })
      } else {
        mergeDescriptor(existing, descriptor)
      }
    }
  } catch (err) {
    notes.push(
      `transport listNodes failed: ${toMeshError(err).message}; node status is unknown where no receipt exists`,
    )
  }

  return { peers: [...peers.values()], notes }
}
