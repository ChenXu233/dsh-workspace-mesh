import type { NodeDescriptor } from '../types.js'
import { toMeshError } from './protocol.js'
import type { MeshToolDefinition, MeshToolRuntime } from './types.js'
import {
  asArgsRecord,
  optionalString,
  rejectUnknownArgs,
  renderJson,
  TRANSPORT_REPORT_SCHEMA,
  transportReport,
  workspaceViews,
  WORKSPACE_VIEW_SCHEMA,
} from './types.js'

type PeerStatus = 'online' | 'offline' | 'unknown'
type PeerSource = 'assignment' | 'transport' | 'both'

interface PeerView {
  nodeId: string
  label: string
  endpoint: string
  status: PeerStatus
  source: PeerSource
  lastSeenAt?: number
  workspaces: ReturnType<typeof workspaceViews>
  assignedWorkspaceIds: string[]
}

const PEER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' },
    label: { type: 'string' },
    endpoint: { type: 'string' },
    status: {
      type: 'string',
      enum: ['online', 'offline', 'unknown'],
      description: 'online/offline come from a transport receipt; unknown means no receipt was seen.',
    },
    source: {
      type: 'string',
      enum: ['assignment', 'transport', 'both'],
      description: 'Where this peer entry came from.',
    },
    lastSeenAt: { type: 'number', description: 'Unix milliseconds from the transport receipt, when known.' },
    workspaces: { type: 'array', items: WORKSPACE_VIEW_SCHEMA },
    assignedWorkspaceIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspaces assignment.yml routes to this node.',
    },
  },
  required: ['nodeId', 'label', 'endpoint', 'status', 'source', 'workspaces', 'assignedWorkspaceIds'],
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    transport: TRANSPORT_REPORT_SCHEMA,
    peers: { type: 'array', items: PEER_SCHEMA },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['transport', 'peers', 'notes'],
}

function assignmentIndex(runtime: MeshToolRuntime): Map<string, string[]> {
  const assigned = new Map<string, string[]>()
  for (const route of runtime.assignment?.assignments ?? []) {
    const list = assigned.get(route.nodeId)
    if (list === undefined) assigned.set(route.nodeId, [route.workspaceId])
    else list.push(route.workspaceId)
  }
  return assigned
}

function seedFromAssignment(runtime: MeshToolRuntime, assigned: Map<string, string[]>): Map<string, PeerView> {
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

function mergeDescriptor(peer: PeerView, descriptor: NodeDescriptor): void {
  if (peer.label === '') peer.label = descriptor.label
  if (peer.endpoint === '') peer.endpoint = descriptor.endpoint
  peer.status = descriptor.online ? 'online' : 'offline'
  peer.source = 'both'
  peer.workspaces = workspaceViews(descriptor.workspaces)
  peer.lastSeenAt = descriptor.lastSeenAt
}

function toWirePeer(peer: PeerView): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    nodeId: peer.nodeId,
    label: peer.label === '' ? peer.nodeId : peer.label,
    endpoint: peer.endpoint,
    status: peer.status,
    source: peer.source,
    workspaces: peer.workspaces,
    assignedWorkspaceIds: peer.assignedWorkspaceIds,
  }
  if (peer.lastSeenAt !== undefined) wire.lastSeenAt = peer.lastSeenAt
  return wire
}

/**
 * mesh_list_nodes — the mesh roster, derived from assignment.yml plus transport
 * receipts. DSH has no core roster service (spike p1 §2.3), so nothing here
 * calls ctx.*; status stays "unknown" until a receipt proves otherwise.
 */
export function createMeshListNodesTool(runtime: MeshToolRuntime): MeshToolDefinition {
  return {
    name: 'mesh_list_nodes',
    description:
      '列出 mesh 已知节点：assignment.yml 声明的节点/工作区与传输回执合并。可用 nodeId 或 workspaceId 过滤；没有配置传输时节点状态为 unknown，绝不伪造 online。不会调用 DSH 核心 roster API（DSH 没有这个概念）。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '只返回该节点。' },
        workspaceId: { type: 'string', description: '只返回承载该工作区的节点（assignment 或传输回执）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(rawArgs) {
      const args = asArgsRecord(rawArgs, 'mesh_list_nodes')
      rejectUnknownArgs(args, ['nodeId', 'workspaceId'], 'mesh_list_nodes')
      const nodeId = optionalString(args, 'nodeId', 'mesh_list_nodes', { nonEmpty: true })
      const workspaceId = optionalString(args, 'workspaceId', 'mesh_list_nodes', { nonEmpty: true })

      const notes: string[] = []
      const assigned = assignmentIndex(runtime)
      const peers = seedFromAssignment(runtime, assigned)

      if (runtime.transport === undefined) {
        notes.push('no transport configured; node status is unknown')
      } else {
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
      }

      let list = [...peers.values()]
      if (nodeId !== undefined) {
        list = list.filter((peer) => peer.nodeId === nodeId)
        if (list.length === 0) notes.push(`node "${nodeId}" is not known to assignment.yml or the transport`)
      }
      if (workspaceId !== undefined) {
        list = list.filter(
          (peer) =>
            peer.assignedWorkspaceIds.includes(workspaceId) ||
            peer.workspaces.some((workspace) => workspace.workspaceId === workspaceId),
        )
        if (list.length === 0) notes.push(`workspace "${workspaceId}" is not assigned to a known node`)
      }

      return {
        transport: transportReport(runtime),
        peers: list.map(toWirePeer),
        notes,
      }
    },
  }
}
