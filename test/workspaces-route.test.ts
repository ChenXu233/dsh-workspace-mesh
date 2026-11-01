import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWorkspacesPayload, mountMeshWorkspacesRoute, readWorkspaceRegistry } from '../src/api/workspaces.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'

/** The peer's native registry is the only source of workspace ids the mesh may target. */

test('the payload projects the registry without inventing ids', () => {
  const payload = buildWorkspacesPayload({
    list: () => [
      { id: 'workspace-abc', title: 'Blog', path: '/data/blog', sessionIds: ['s1', 's2'] },
      { id: 'workspace-def', title: '', path: '/data/other', sessionIds: [] },
    ],
  })
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.workspaces, [
    { workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog', sessions: 2 },
    { workspaceId: 'workspace-def', title: '', path: '/data/other', sessions: 0 },
  ])
})

test('a composition without the registry reports why instead of failing', () => {
  const payload = buildWorkspacesPayload(undefined)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.workspaces, [])
  assert.match(String(payload.note), /workspaceRegistry/)
})

test('readWorkspaceRegistry tolerates a context without the service', () => {
  assert.equal(readWorkspaceRegistry(undefined), undefined)
  assert.equal(readWorkspaceRegistry({ get: () => { throw new Error('cannot get property') } }), undefined)
  assert.equal(readWorkspaceRegistry({ get: () => ({}) }), undefined)
  const registry = { list: () => [] }
  assert.equal(readWorkspaceRegistry({ get: () => registry }), registry)
})

test('the route is mounted on GET only', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  assert.equal(mountMeshWorkspacesRoute(ctx, () => ({ list: () => [] })), true)
  assert.equal(routes[0]?.path, '/api/mesh/workspaces')
  assert.deepEqual(routes[0]?.methods, ['GET'])
})
