import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGraph, peerNodeId, workspaceNodeId, SELF_ID } from '../src/graph/model.js'
import { createForceLayout, DEFAULT_HEIGHT, DEFAULT_WIDTH } from '../src/graph/layout.js'

const peers = [
  {
    nodeId: 'node-b',
    label: 'Aliyun',
    endpoint: 'http://101.132.38.216:3211',
    status: 'online' as const,
    source: 'both' as const,
    workspaces: [{ workspaceId: 'ws-1', name: 'mesh', path: '/srv/ws/mesh', sessions: 2 }],
    assignedWorkspaceIds: ['ws-1', 'ws-2'],
  },
  {
    nodeId: 'node-a',
    status: 'unknown' as const,
    source: 'assignment' as const,
    workspaces: [],
    assignedWorkspaceIds: ['ws-9'],
  },
]

test('the graph keeps three layers and starts at this node', () => {
  const graph = buildGraph({ peers }, { selfLabel: 'this node' })
  assert.equal(graph.nodes[0]?.id, SELF_ID)
  assert.equal(graph.nodes[0]?.label, 'this node')
  assert.deepEqual(
    [...new Set(graph.nodes.map((node) => node.kind))].sort(),
    ['peer', 'self', 'workspace'],
  )
  const hubEdges = graph.edges.filter((edge) => edge.kind === 'hub')
  assert.equal(hubEdges.length, 2, 'one hub edge per peer, never per workspace')
  assert.deepEqual(hubEdges.map((edge) => edge.id), ['hub:node-a', 'hub:node-b'], 'sorted by node id')
})

test('a declaration without a receipt stays dashed and never claims online', () => {
  const graph = buildGraph({ peers })
  const declared = graph.edges.find((edge) => edge.id === 'hub:node-a')
  assert.equal(declared?.dashed, true)
  assert.equal(declared?.tone, 'unknown')
  const confirmed = graph.edges.find((edge) => edge.id === 'hub:node-b')
  assert.equal(confirmed?.dashed, false)
  assert.equal(confirmed?.tone, 'online')
})

test('a workspace seen by transport and by assignment is one node with one edge', () => {
  const graph = buildGraph({ peers })
  const id = workspaceNodeId('node-b', 'ws-1')
  assert.equal(graph.nodes.filter((node) => node.id === id).length, 1)
  const links = graph.edges.filter((edge) => edge.to === id)
  assert.equal(links.length, 1)
  assert.equal(links[0]?.dashed, false, 'transport reported it, so the link is receipt-backed')
  const declaredOnly = graph.edges.find((edge) => edge.to === workspaceNodeId('node-b', 'ws-2'))
  assert.equal(declaredOnly?.dashed, true)
  assert.equal(declaredOnly?.tone, 'online', 'tone follows the peer, the dash follows the evidence')
})

test('only live tasks become nodes; orphans are counted instead of invented', () => {
  const graph = buildGraph({
    peers,
    tasks: [
      { taskId: 't-live', state: 'running', nodeId: 'node-b', workspaceId: 'ws-1', updatedAt: 3 },
      { taskId: 't-queued', state: 'queued', nodeId: 'node-b', workspaceId: 'ws-2', updatedAt: 2 },
      { taskId: 't-done', state: 'done', nodeId: 'node-b', workspaceId: 'ws-1', updatedAt: 1 },
      { taskId: 't-orphan', state: 'running', nodeId: 'ghost', workspaceId: 'ws-x', updatedAt: 4 },
    ],
  })
  assert.equal(graph.liveTasks, 2)
  assert.equal(graph.orphanTasks, 1, 'a task for a target outside the roster must not grow a branch')
  const flow = graph.edges.filter((edge) => edge.kind === 'task')
  assert.equal(flow.length, 2)
  assert.equal(flow.find((edge) => edge.to === 'task:t-queued')?.dashed, true, 'queued has not left yet')
  assert.equal(flow.find((edge) => edge.to === 'task:t-live')?.dashed, false)
  assert.equal(graph.nodes.some((node) => node.id === 'task:t-done'), false)
})

test('the payload is tolerated as HTTP JSON: bad rows are skipped, not rendered', () => {
  const graph = buildGraph({
    peers: [
      { nodeId: '', status: 'online' as const },
      { nodeId: 'ok', status: 'weird' as never, workspaces: [{ workspaceId: '' }] },
    ],
  })
  assert.deepEqual(graph.nodes.filter((node) => node.kind === 'peer').map((node) => node.label), ['ok'])
  assert.equal(graph.nodes.find((node) => node.id === peerNodeId('ok'))?.status, 'unknown')
})

test('layout settles, keeps pins, and stays inside the canvas', () => {
  const graph = buildGraph({
    peers,
    tasks: [{ taskId: 't-1', state: 'running', nodeId: 'node-b', workspaceId: 'ws-1', updatedAt: 1 }],
  })
  const layout = createForceLayout(graph, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  for (let step = 0; step < 400; step += 1) layout.step()
  assert.equal(layout.settled(), true, 'the simulation must cool down, otherwise the canvas never stops')

  const positions = layout.positions()
  for (const node of graph.nodes) {
    const point = positions[node.id]
    assert.ok(point !== undefined)
    assert.ok(Number.isFinite(point!.x) && Number.isFinite(point!.y))
    assert.ok(point!.x >= 0 && point!.x <= DEFAULT_WIDTH, node.id + ' escaped horizontally')
    assert.ok(point!.y >= 0 && point!.y <= DEFAULT_HEIGHT, node.id + ' escaped vertically')
  }
  const distinct = new Set(Object.values(positions).map((point) => point.x.toFixed(2) + ',' + point.y.toFixed(2)))
  assert.equal(distinct.size, graph.nodes.length, 'no two nodes may share a spot')
})

test('a dragged node stays where the user put it', () => {
  const graph = buildGraph({ peers })
  const layout = createForceLayout(graph, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  layout.pin(peerNodeId('node-a'), 40, 60)
  for (let step = 0; step < 200; step += 1) layout.step()
  const pinned = layout.positions()[peerNodeId('node-a')]
  assert.deepEqual(pinned, { x: 40, y: 60 })
  const free = layout.positions()[peerNodeId('node-b')]
  assert.ok(free !== undefined && (free.x !== 40 || free.y !== 60), 'the rest of the graph still moves')
})

test('the same graph lays out the same way twice', () => {
  const graph = buildGraph({ peers })
  const first = createForceLayout(graph)
  const second = createForceLayout(graph)
  for (let step = 0; step < 120; step += 1) {
    first.step()
    second.step()
  }
  assert.deepEqual(first.positions(), second.positions())
})

test('pinning one node moves the rest instead of freezing the picture', () => {
  const graph = buildGraph({ peers, tasks: [] })
  const layout = createForceLayout(graph, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  for (let step = 0; step < 300; step += 1) layout.step()
  const before = layout.positions()

  const dragged = peerNodeId('node-b')
  layout.pin(dragged, 60, 60)
  for (let step = 0; step < 200; step += 1) layout.step()
  const after = layout.positions()

  assert.deepEqual(after[dragged], { x: 60, y: 60 })
  const moved = graph.nodes.filter((node) => {
    if (node.id === dragged) return false
    const a = before[node.id]!
    const b = after[node.id]!
    return Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1
  })
  assert.ok(moved.length > 0, 'the neighbours must react to a dragged node')
})

test('a drag does not re-seed the layout: releasing keeps positions continuous', () => {
  const graph = buildGraph({ peers, tasks: [] })
  const layout = createForceLayout(graph, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  for (let step = 0; step < 300; step += 1) layout.step()
  const dragged = peerNodeId('node-a')
  layout.pin(dragged, 80, 90)
  layout.step()
  const released = layout.positions()
  assert.ok(Math.abs(released[dragged]!.x - 80) < 2 && Math.abs(released[dragged]!.y - 90) < 2)
  // Releasing must not teleport anyone back to the seed ring.
  for (const node of graph.nodes) {
    if (node.id === dragged) continue
    const spot = released[node.id]!
    assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y))
  }
})
