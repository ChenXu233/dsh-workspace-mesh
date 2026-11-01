import assert from 'node:assert/strict'
import test from 'node:test'

import { handleDispatch, MESH_DISPATCH_PATH, mountMeshDispatchRoute } from '../src/api/dispatch.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import { createMockTransport } from '../src/transport/mock.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/index.js'

/** The browser entry point must behave exactly like the mesh_dispatch tool. */

function runtime(overrides: Partial<MeshToolRuntime> = {}, config: Partial<MeshToolConfig> = {}): MeshToolRuntime {
  const transport = createMockTransport({
    now: () => 1_000,
    nodes: [{ nodeId: 'node-a', label: 'Node A', endpoint: 'mock://a', workspaces: [{ workspaceId: 'ws-1', name: 'One', path: '/w/1' }] }],
    autoRespond: () => [{ type: 'assistant/message', text: 'done from the peer', final: true }],
  })
  return {
    board: createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    transport,
    assignment: {
      file: 'test.yml',
      nodes: [{ nodeId: 'node-a', label: 'Node A', endpoint: 'mock://a', line: 1 }],
      assignments: [{ workspaceId: 'ws-1', nodeId: 'node-a', cwd: '/w/1', line: 1 }],
    },
    config: {
      transportMode: 'auto',
      leaseMs: 900_000,
      dispatchTimeoutMs: 5_000,
      leaseOwner: 'lead',
      ...config,
    },
    now: () => 1_000,
    ...overrides,
  }
}

function post(body: unknown): Request {
  return new Request('http://dsh.internal' + MESH_DISPATCH_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /api/mesh/dispatch runs the same path as the tool and returns the reply', async () => {
  const response = await handleDispatch(post({ workspaceId: 'ws-1', objective: 'say hi' }), { runtime: runtime() })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.state, 'done')
  assert.equal(body.result.summary, 'done from the peer')
  assert.equal(typeof body.taskId, 'string')
  assert.equal(body.target.nodeId, 'node-a')
})

test('the route rejects a body without a workspace or an objective', async () => {
  const missingWorkspace = await handleDispatch(post({ objective: 'x' }), { runtime: runtime() })
  assert.equal(missingWorkspace.status, 400)
  const missingObjective = await handleDispatch(post({ workspaceId: 'ws-1' }), { runtime: runtime() })
  assert.equal(missingObjective.status, 400)
  const notJson = await handleDispatch(new Request('http://dsh.internal/x', { method: 'POST', body: 'nope' }), { runtime: runtime() })
  assert.equal(notJson.status, 400)
})

test('only the documented arguments reach the tool', async () => {
  const response = await handleDispatch(
    post({ workspaceId: 'ws-1', objective: 'say hi', sneaky: 'ignored', replyMode: 'final' }),
    { runtime: runtime() },
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.state, 'done')
})

test('a host without a transport reports unavailable instead of throwing', async () => {
  const response = await handleDispatch(post({ workspaceId: 'ws-1', objective: 'x' }), {
    runtime: runtime({ transport: undefined, transportError: 'no peers configured' }),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unavailable')
})

test('the route is mounted on the exact path with POST only', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = {
    get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }),
  }
  assert.equal(mountMeshDispatchRoute(ctx, { runtime: runtime() }), true)
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.path, MESH_DISPATCH_PATH)
  assert.deepEqual(routes[0]?.methods, ['POST'])
})
