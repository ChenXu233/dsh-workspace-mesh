import { deriveRoster, wirePeer } from '../roster/index.js'
import type { MeshToolDefinition, MeshToolRuntime } from './types.js'
import {
  asArgsRecord,
  optionalString,
  rejectUnknownArgs,
  renderJson,
  TRANSPORT_REPORT_SCHEMA,
  transportReport,
  WORKSPACE_VIEW_SCHEMA,
} from './types.js'

const PEER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' },
    label: { type: 'string' },
    endpoint: { type: 'string' },
    online: {
      type: 'boolean',
      description: 'SPEC §18 NodeDescriptor.online; true only when a transport receipt says online.',
    },
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
  required: ['nodeId', 'label', 'endpoint', 'online', 'status', 'source', 'workspaces', 'assignedWorkspaceIds'],
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

      const roster = await deriveRoster(runtime)
      const notes = [...roster.notes]

      let list = roster.peers
      if (nodeId !== undefined) {
        list = list.filter((peer) => peer.nodeId === nodeId)
        if (list.length === 0) notes.push('node "' + nodeId + '" is not known to assignment.yml or the transport')
      }
      if (workspaceId !== undefined) {
        list = list.filter(
          (peer) =>
            peer.assignedWorkspaceIds.includes(workspaceId) ||
            peer.workspaces.some((workspace) => workspace.workspaceId === workspaceId),
        )
        if (list.length === 0) notes.push('workspace "' + workspaceId + '" is not assigned to a known node')
      }

      return {
        transport: transportReport(runtime),
        peers: list.map(wirePeer),
        notes,
      }
    },
  }
}
