/**
 * Topology graph derivation shared by the browser canvas and the node tests.
 *
 * Pure by construction: no DOM, no timers, no I/O, no package imports. It turns
 * one \`/api/mesh/state\` payload into the nodes and edges the canvas draws, so
 * "what the picture claims" can be asserted without a browser. The browser half
 * bundles this module; the host half compiles it so \`node --test\` can check it.
 */

export type NodeKind = 'self' | 'peer' | 'workspace' | 'task'
export type PeerStatus = 'online' | 'offline' | 'unknown'
export type PeerSource = 'assignment' | 'transport' | 'both'

/** Peer row as served by src/roster (fields tolerated as optional: HTTP JSON). */
export interface PeerInput {
  nodeId: string
  label?: string
  endpoint?: string
  status?: PeerStatus
  source?: PeerSource
  lastSeenAt?: number
  workspaces?: Array<{ workspaceId: string; name?: string; path?: string; sessions?: number }>
  assignedWorkspaceIds?: string[]
}

/** Task row as served by /api/mesh/state (objective preview is not drawn). */
export interface TaskInput {
  taskId: string
  state: string
  nodeId: string
  workspaceId: string
  updatedAt?: number
}

export interface MeshStateInput {
  peers?: PeerInput[]
  tasks?: TaskInput[]
}

export interface GraphNode {
  /** Stable key: \`self\`, \`node:<nodeId>\`, \`ws:<nodeId>/<workspaceId>\`, \`task:<taskId>\`. */
  id: string
  kind: NodeKind
  label: string
  /** Second line: endpoint, path, or task state. */
  sublabel: string
  status: PeerStatus
  /** Inspector rows, already human-readable and never longer than the payload. */
  detail: Array<[string, string]>
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  kind: 'hub' | 'workspace' | 'task'
  /** Liveness of the relationship, copied from the peer it belongs to. */
  tone: PeerStatus
  /** True when the link is declaration-only (no receipt behind it). */
  dashed: boolean
}

export interface MeshGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Task states drawn as nodes. */
  liveTasks: number
  /** Live tasks whose target (node, workspace) never appeared in the roster. */
  orphanTasks: number
}

export interface BuildOptions {
  /** Label for the node serving the page; the client passes the localized text. */
  selfLabel?: string
}

/** The only task states that are worth a node: the work that is still moving. */
export const LIVE_TASK_STATES: readonly string[] = ['queued', 'dispatched', 'running']

export const SELF_ID = 'self'

export function peerNodeId(nodeId: string): string {
  return 'node:' + nodeId
}

export function workspaceNodeId(nodeId: string, workspaceId: string): string {
  return 'ws:' + nodeId + '/' + workspaceId
}

export function taskNodeId(taskId: string): string {
  return 'task:' + taskId
}

function statusOf(peer: PeerInput): PeerStatus {
  const status = peer.status
  if (status === 'online' || status === 'offline' || status === 'unknown') return status
  return 'unknown'
}

function sourceLabel(source: PeerSource | undefined): string {
  if (source === 'transport') return 'transport'
  if (source === 'both') return 'assignment + transport'
  return 'assignment'
}

/**
 * Build the three layers: this node → peers → workspaces → live tasks.
 *
 * Ordering is sorted by ids so the same payload always yields the same nodes in
 * the same order — the layout is deterministic, so the picture is too.
 */
export function buildGraph(state: MeshStateInput, options: BuildOptions = {}): MeshGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  let liveTasks = 0
  let orphanTasks = 0

  const addNode = (node: GraphNode): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    nodes.push(node)
  }

  addNode({
    id: SELF_ID,
    kind: 'self',
    label: options.selfLabel !== undefined && options.selfLabel !== '' ? options.selfLabel : 'self',
    sublabel: '',
    status: 'online',
    detail: [],
  })

  const peers = [...(state.peers ?? [])]
    .filter((peer) => typeof peer.nodeId === 'string' && peer.nodeId !== '')
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))

  for (const peer of peers) {
    const nodeId = peer.nodeId
    const status = statusOf(peer)
    const reported = new Map<string, { name?: string; path?: string; sessions?: number }>()
    for (const workspace of peer.workspaces ?? []) {
      if (typeof workspace.workspaceId !== 'string' || workspace.workspaceId === '') continue
      reported.set(workspace.workspaceId, workspace)
    }
    const assigned = new Set<string>()
    for (const workspaceId of peer.assignedWorkspaceIds ?? []) {
      if (typeof workspaceId === 'string' && workspaceId !== '') assigned.add(workspaceId)
    }

    const detail: Array<[string, string]> = []
    if (peer.endpoint !== undefined && peer.endpoint !== '') detail.push(['endpoint', peer.endpoint])
    detail.push(['status', status])
    detail.push(['source', sourceLabel(peer.source)])
    if (peer.lastSeenAt !== undefined && peer.lastSeenAt > 0) detail.push(['last seen', String(peer.lastSeenAt)])

    addNode({
      id: peerNodeId(nodeId),
      kind: 'peer',
      label: peer.label !== undefined && peer.label !== '' ? peer.label : nodeId,
      sublabel: peer.label !== undefined && peer.label !== '' && peer.label !== nodeId ? nodeId : status,
      status,
      detail,
    })
    edges.push({
      id: 'hub:' + nodeId,
      from: SELF_ID,
      to: peerNodeId(nodeId),
      kind: 'hub',
      tone: status,
      dashed: peer.source === 'assignment' || peer.source === undefined,
    })

    const workspaceIds = [...new Set([...reported.keys(), ...assigned])].sort()
    for (const workspaceId of workspaceIds) {
      const info = reported.get(workspaceId)
      const id = workspaceNodeId(nodeId, workspaceId)
      const wsDetail: Array<[string, string]> = [['owner', nodeId], ['workspace', workspaceId]]
      if (info?.path !== undefined && info.path !== '') wsDetail.push(['path', info.path])
      if (info?.sessions !== undefined) wsDetail.push(['sessions', String(info.sessions)])
      wsDetail.push(['seen by', info === undefined ? 'assignment only' : 'transport'])
      addNode({
        id,
        kind: 'workspace',
        label: info?.name !== undefined && info.name !== '' ? info.name : workspaceId,
        sublabel: info?.path !== undefined && info.path !== '' ? info.path : workspaceId,
        status,
        detail: wsDetail,
      })
      edges.push({
        id: 'own:' + nodeId + '/' + workspaceId,
        from: peerNodeId(nodeId),
        to: id,
        kind: 'workspace',
        tone: status,
        dashed: info === undefined,
      })
    }
  }

  const tasks = [...(state.tasks ?? [])]
    .filter((task) => LIVE_TASK_STATES.includes(task.state))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))

  for (const task of tasks) {
    const workspace = workspaceNodeId(task.nodeId, task.workspaceId)
    if (!seen.has(workspace)) {
      // The board can hold a task for a target that has left the roster; drawing
      // a half-invented branch would claim a relationship nobody can verify.
      orphanTasks += 1
      continue
    }
    liveTasks += 1
    addNode({
      id: taskNodeId(task.taskId),
      kind: 'task',
      label: task.taskId,
      sublabel: task.state,
      status: 'online',
      detail: [['state', task.state], ['target', task.nodeId + ' / ' + task.workspaceId]],
    })
    edges.push({
      id: 'flow:' + task.taskId,
      from: workspace,
      to: taskNodeId(task.taskId),
      kind: 'task',
      tone: task.state === 'queued' ? 'unknown' : 'online',
      dashed: task.state === 'queued',
    })
  }

  return { nodes, edges, liveTasks, orphanTasks }
}
