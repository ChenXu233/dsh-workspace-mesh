import assert from 'node:assert/strict'
import test from 'node:test'

import { MESH_STATE_PATH, mountMeshStateRoute, registerMeshStateRoute } from '../src/api/index.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/index.js'
import { buildMeshState, MAX_TASK_ROWS, MESH_STATE_VERSION } from '../src/api/state.js'
import { parseAssignment } from '../src/assignments/index.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import { createMockTransport } from '../src/transport/mock.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/index.js'
import type { Task, TaskState } from '../src/types.js'

function makeRuntime(options: {
  transport?: ReturnType<typeof createMockTransport>
  assignmentYaml?: string
  config?: Partial<MeshToolConfig>
  board?: ReturnType<typeof createInMemoryBoard>
} = {}): MeshToolRuntime {
  const runtime: MeshToolRuntime = {
    board: options.board ?? createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    config: {
      transportMode: 'auto',
      leaseMs: 900_000,
      dispatchTimeoutMs: 120_000,
      leaseOwner: 'mesh-lead',
      ...options.config,
    },
    now: () => 1_000,
  }
  if (options.transport !== undefined) runtime.transport = options.transport
  if (options.assignmentYaml !== undefined) runtime.assignment = parseAssignment(options.assignmentYaml, 'state-test.yml')
  return runtime
}

function makeTask(taskId: string, state: TaskState, updatedAt: number, objective = 'objective ' + taskId): Task {
  return {
    taskId,
    target: { nodeId: 'node-a', workspaceId: 'ws-1' },
    objective,
    policy: { sessionMode: 'new', replyMode: 'final' },
    lease: { owner: '', fencingToken: 0, expiresAt: 0 },
    state,
    createdAt: 1_000,
    updatedAt,
  }
}

/** Context double: a service map plus an injection hook the test drives by hand. */
function fakeContext(services: Record<string, unknown>) {
  const state: { pending: Array<{ deps: string[]; callback: (inner: MeshRouteContext) => void }> } = { pending: [] }
  const ctx: MeshRouteContext = {
    get(name: string) {
      return services[name]
    },
    inject(deps: string[], callback: (inner: MeshRouteContext) => void) {
      state.pending.push({ deps, callback })
      return {}
    },
  }
  return { ctx, state }
}

function connectionDouble(routes: MeshFetchRoute[]) {
  return {
    fetch: {
      register(route: MeshFetchRoute) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

const ASSIGNMENT_YAML = `nodes:
  node-a: { label: Node A, endpoint: mock://a }
assignments:
  - { workspaceId: ws-1, nodeId: node-a }
`

test('buildMeshState degrades to a complete snapshot without transport', async () => {
  const payload = await buildMeshState(makeRuntime(), () => 4_242)
  assert.equal(payload.ok, true)
  assert.equal(payload.version, MESH_STATE_VERSION)
  assert.equal(payload.plugin, 'dsh-workspace-mesh')
  assert.equal(payload.generatedAt, 4_242)
  assert.equal(payload.transport.configured, false)
  assert.equal(payload.transport.reason, 'no transport configured')
  assert.deepEqual(payload.peers, [])
  assert.deepEqual(payload.tasks, [])
  assert.deepEqual(payload.assignment, { configured: false, file: '', nodes: 0, assignments: 0 })
  assert.deepEqual(payload.counts, { total: 0, queued: 0, dispatched: 0, running: 0, done: 0, failed: 0, expired: 0 })
  assert.ok(payload.notes.includes('no transport configured; node status is unknown'))
})

test('buildMeshState merges assignment.yml with transport receipts', async () => {
  const transport = createMockTransport({
    now: () => 1_000,
    nodes: [
      { nodeId: 'node-a', label: 'Node A', endpoint: 'mock://a', online: true, lastSeenAt: 9_000,
        workspaces: [{ workspaceId: 'ws-1', name: 'One', path: '/w/1' }] },
      { nodeId: 'node-b', label: 'Node B', endpoint: 'mock://b', online: false,
        workspaces: [{ workspaceId: 'ws-2', name: 'Two', path: '/w/2' }] },
    ],
  })
  const payload = await buildMeshState(makeRuntime({ transport, assignmentYaml: ASSIGNMENT_YAML }), () => 10_000)
  assert.equal(payload.transport.configured, true)
  assert.equal(payload.transport.kind, 'mock')
  assert.deepEqual(payload.assignment, { configured: true, file: 'state-test.yml', nodes: 1, assignments: 1 })
  const nodeA = payload.peers.find((peer) => peer.nodeId === 'node-a')
  const nodeB = payload.peers.find((peer) => peer.nodeId === 'node-b')
  assert.ok(nodeA !== undefined && nodeB !== undefined)
  assert.equal(nodeA.status, 'online')
  assert.equal(nodeA.source, 'both')
  assert.equal(nodeA.lastSeenAt, 9_000)
  assert.deepEqual(nodeA.assignedWorkspaceIds, ['ws-1'])
  assert.equal(nodeB.status, 'offline')
  assert.equal(nodeB.source, 'transport')
})

test('buildMeshState counts board states and keeps the newest tasks', async () => {
  const board = createInMemoryBoard(() => 5_000)
  for (let index = 0; index < MAX_TASK_ROWS + 3; index += 1) {
    const state: TaskState = index === 0 ? 'running' : index === 1 ? 'done' : 'queued'
    assert.equal(board.create(makeTask('task-' + index, state, 1_000 + index)), true)
  }
  const payload = await buildMeshState(makeRuntime({ board, transport: createMockTransport({ now: () => 1_000 }) }), () => 10_000)
  assert.equal(payload.counts.total, MAX_TASK_ROWS + 3)
  assert.equal(payload.counts.running, 1)
  assert.equal(payload.counts.done, 1)
  assert.equal(payload.counts.queued, MAX_TASK_ROWS + 1)
  assert.equal(payload.tasks.length, MAX_TASK_ROWS)
  assert.equal(payload.tasks[0]?.taskId, 'task-' + (MAX_TASK_ROWS + 2))
  assert.equal(payload.tasks[0]?.state, 'queued')
})

test('buildMeshState truncates long objectives', async () => {
  const board = createInMemoryBoard(() => 1_000)
  board.create(makeTask('long', 'queued', 1_000, 'x'.repeat(400)))
  const payload = await buildMeshState(makeRuntime({ board }), () => 2_000)
  const objective = payload.tasks[0]?.objective ?? ''
  assert.equal(objective.endsWith('…'), true)
  assert.equal(objective.length, 161)
})

test('mountMeshStateRoute serves GET /api/mesh/state inside connection.fetch', async () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: (name) => (name === 'connection' ? connectionDouble(routes) : undefined) }
  assert.equal(mountMeshStateRoute(ctx, makeRuntime()), true)
  assert.equal(routes.length, 1)
  const route = routes[0]!
  assert.equal(route.path, MESH_STATE_PATH)
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  const response = await route.fetch(new Request('http://dsh.internal/api/mesh/state'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.version, MESH_STATE_VERSION)
})

test('registerMeshStateRoute mounts through a later connection service', () => {
  const routes: MeshFetchRoute[] = []
  const { ctx, state } = fakeContext({})
  registerMeshStateRoute(ctx as never, makeRuntime())
  assert.equal(state.pending.length, 1)
  assert.deepEqual(state.pending[0]?.deps, ['connection'])
  assert.equal(routes.length, 0)

  // Connection starts after mesh: the injection callback mounts the route then.
  const inner: MeshRouteContext = { get: (name) => (name === 'connection' ? connectionDouble(routes) : undefined) }
  state.pending[0]?.callback(inner)
  assert.equal(routes.length, 1)
})

test('registerMeshStateRoute is a no-op without a connection service', () => {
  const routes: MeshFetchRoute[] = []
  const empty: MeshRouteContext = { get: () => undefined }
  assert.equal(mountMeshStateRoute(empty, makeRuntime()), false)
  const { ctx, state } = fakeContext({})
  registerMeshStateRoute(ctx as never, makeRuntime())
  state.pending[0]?.callback(empty)
  assert.equal(routes.length, 0)
})

test('registerMeshStateRoute reports a 500 when the snapshot cannot be built', async () => {
  const routes: MeshFetchRoute[] = []
  const { ctx, state } = fakeContext({})
  const runtime = makeRuntime()
  runtime.lifecycle = {
    status() {
      throw new Error('boom')
    },
  } as unknown as MeshToolRuntime['lifecycle']
  registerMeshStateRoute(ctx as never, runtime)
  const inner: MeshRouteContext = { get: (name) => (name === 'connection' ? connectionDouble(routes) : undefined) }
  state.pending[0]?.callback(inner)
  const response = await routes[0]!.fetch(new Request('http://dsh.internal/api/mesh/state'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(body.ok, false)
  assert.equal(body.error, 'boom')
})
