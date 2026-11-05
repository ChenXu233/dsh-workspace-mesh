import assert from 'node:assert/strict'
import test from 'node:test'

import { handleSessionRead, MESH_SESSION_PATH, mountMeshSessionRoute } from '../src/api/session.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/index.js'
import type { MeshSessionMessage, MeshTransport } from '../src/transport/types.js'

/** The page reads remote history through the transport, never from a cache. */

function runtime(overrides: Partial<MeshToolRuntime> = {}): MeshToolRuntime {
  const transport: MeshTransport = {
    kind: 'mock',
    listNodes: async () => [],
    listWorkspaces: async () => [],
    createSession: async () => 'session-x',
    prompt: async () => {},
    follow: async () => () => {},
    readSession: async (): Promise<MeshSessionMessage[]> => [
      { seq: 1, role: 'user', text: 'hello' },
      { seq: 2, role: 'assistant', text: 'hi' },
    ],
  }
  const config: MeshToolConfig = { transportMode: 'auto', leaseMs: 900_000, dispatchTimeoutMs: 5_000, leaseOwner: 'lead' }
  return {
    board: createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    transport,
    config,
    now: () => 1_000,
    ...overrides,
  }
}

function get(query: string): Request {
  return new Request('http://dsh.internal' + MESH_SESSION_PATH + query, { method: 'GET' })
}

test('GET /api/mesh/session returns the projected conversation', async () => {
  const response = await handleSessionRead(get('?nodeId=peer-a&sessionId=session-1'), { runtime: runtime() })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.deepEqual(body.messages.map((m: any) => [m.role, m.text]), [['user', 'hello'], ['assistant', 'hi']])
})

test('nodeId and sessionId are required', async () => {
  const response = await handleSessionRead(get('?sessionId=session-1'), { runtime: runtime() })
  assert.equal(response.status, 400)
})

test('a transport without history support reports it instead of throwing', async () => {
  const noHistory: MeshTransport = {
    kind: 'mock',
    listNodes: async () => [],
    listWorkspaces: async () => [],
    createSession: async () => 'session-x',
    prompt: async () => {},
    follow: async () => () => {},
  }
  const response = await handleSessionRead(get('?nodeId=peer-a&sessionId=s1'), { runtime: runtime({ transport: noHistory }) })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, false)
  assert.equal(body.code, 'unavailable')
})

test('the route is mounted on GET only', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  assert.equal(mountMeshSessionRoute(ctx, { runtime: runtime() }), true)
  assert.equal(routes[0]?.path, MESH_SESSION_PATH)
  assert.deepEqual(routes[0]?.methods, ['GET'])
})
