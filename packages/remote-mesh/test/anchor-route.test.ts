import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'

import { handleAnchor, MESH_ANCHOR_PATH, mountMeshAnchorRoute, prepareMeshAnchor, registerMeshAnchorRoute } from '../src/api/anchor.js'
import type { AnchorWorkspaceRegistry } from '../src/api/anchor.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import type { MeshToolRuntime } from '../src/tools/types.js'

function runtimeFixture(): MeshToolRuntime {
  return {
    assignment: {
      file: '/config/assignment.yml',
      nodes: [{ nodeId: 'cloud', label: 'Cloud' }],
      assignments: [{ workspaceId: 'ws-blog', nodeId: 'cloud', cwd: '/srv/blog' }],
    },
    config: { transportMode: 'auto', leaseMs: 900000, dispatchTimeoutMs: 120000, leaseOwner: 'mesh-lead' },
    board: { list: () => [] },
    lifecycle: { status: () => ({ state: 'ready', supervisor: 'unknown', pid: 1, startedAt: 0 }) },
  } as unknown as MeshToolRuntime
}

test('anchor preparation creates a self-describing directory and a titled native record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: Array<{ path: string; title?: string }> = []
  const registry = {
    list: () => [],
    create: async (path: string, title?: string) => {
      calls.push({ path, title })
      return { id: 'local-anchor-id', path, title: title ?? '', sessionIds: [] }
    },
  }
  const result = await prepareMeshAnchor(runtimeFixture(), registry, 'cloud', 'ws-blog', root)
  assert.equal(result.workspace.workspaceId, 'local-anchor-id')
  assert.equal(result.workspace.title, 'blog @Cloud')
  assert.equal(calls.length, 1)
  assert.equal((await stat(result.path)).isDirectory(), true)
  const metadata = JSON.parse(await readFile(join(result.path, '.dsh-remote.json'), 'utf8'))
  assert.deepEqual(metadata, { version: 1, nodeId: 'cloud', workspaceId: 'ws-blog', remoteCwd: '/srv/blog' })
  assert.match(await readFile(join(result.path, 'README.md'), 'utf8'), /agent loop/i)
})

test('anchor preparation isolates workspace ids that share a remote cwd', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = runtimeFixture()
  runtime.assignment!.assignments.push({ workspaceId: 'ws-blog-copy', nodeId: 'cloud', cwd: '/srv/blog', line: 2 })
  let createdCount = 0
  const registry = {
    list: () => [],
    create: async (path: string, title?: string) => ({
      id: `local-anchor-${++createdCount}`,
      path,
      title: title ?? '',
      sessionIds: [],
    }),
  }

  const original = await prepareMeshAnchor(runtime, registry, 'cloud', 'ws-blog', root)
  const copy = await prepareMeshAnchor(runtime, registry, 'cloud', 'ws-blog-copy', root)
  assert.notEqual(original.path, copy.path)
  const originalMetadata = JSON.parse(await readFile(join(original.path, '.dsh-remote.json'), 'utf8'))
  const copyMetadata = JSON.parse(await readFile(join(copy.path, '.dsh-remote.json'), 'utf8'))
  assert.deepEqual(originalMetadata, { version: 1, nodeId: 'cloud', workspaceId: 'ws-blog', remoteCwd: '/srv/blog' })
  assert.deepEqual(copyMetadata, { version: 1, nodeId: 'cloud', workspaceId: 'ws-blog-copy', remoteCwd: '/srv/blog' })
})


test('anchor preparation includes node identity in Windows directory keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = runtimeFixture()
  runtime.assignment!.assignments.push({ workspaceId: 'ws-blog', nodeId: 'Cloud', cwd: '/srv/blog', line: 2 })
  let createdCount = 0
  const registry = {
    list: () => [],
    create: async (path: string, title?: string) => ({
      id: `local-anchor-${++createdCount}`,
      path,
      title: title ?? '',
      sessionIds: [],
    }),
  }

  const lower = await prepareMeshAnchor(runtime, registry, 'cloud', 'ws-blog', root)
  const upper = await prepareMeshAnchor(runtime, registry, 'Cloud', 'ws-blog', root)
  assert.notEqual(lower.path.toLowerCase(), upper.path.toLowerCase())
})

test('anchor preparation hashes raw node ids into alias-free Windows directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = runtimeFixture()
  const nodeIds = ['NUL', 'nul', 'CON', 'con', 'cloud.', 'cloud', 'Cloud']
  for (const [index, nodeId] of nodeIds.entries()) {
    if (nodeId !== 'cloud') {
      runtime.assignment!.assignments.push({ workspaceId: 'ws-blog', nodeId, cwd: '/srv/blog', line: index + 2 })
    }
  }
  let createdCount = 0
  const registry = {
    list: () => [],
    create: async (path: string, title?: string) => ({
      id: `local-anchor-${++createdCount}`,
      path,
      title: title ?? '',
      sessionIds: [],
    }),
  }

  const directories = new Set<string>()
  for (const nodeId of nodeIds) {
    const result = await prepareMeshAnchor(runtime, registry, nodeId, 'ws-blog', root)
    const nodeDirectory = relative(root, result.path).split(sep)[0]!
    assert.match(nodeDirectory, /^[0-9a-f]{64}$/)
    const windowsKey = nodeDirectory.toLowerCase()
    assert.equal(directories.has(windowsKey), false, `duplicate Windows directory for ${nodeId}`)
    directories.add(windowsKey)
  }
})

test('anchor preparation returns the existing record title and realpath', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const existing = { id: 'existing-local-id', path: '', title: 'Renamed existing workspace', sessionIds: ['session-1'] }
  const registry = {
    list: () => [],
    create: async (path: string) => {
      existing.path = await realpath(path)
      return existing
    },
  }

  const result = await prepareMeshAnchor(runtimeFixture(), registry, 'cloud', 'ws-blog', root)
  assert.equal(result.path, existing.path)
  assert.deepEqual(result.workspace, {
    workspaceId: 'existing-local-id',
    title: 'Renamed existing workspace',
    path: existing.path,
  })
})

test('anchor preparation refuses to overwrite mismatched target metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let createdCount = 0
  const registry = {
    list: () => [],
    create: async (path: string, title?: string) => ({
      id: `local-anchor-${++createdCount}`,
      path,
      title: title ?? '',
      sessionIds: [],
    }),
  }
  const created = await prepareMeshAnchor(runtimeFixture(), registry, 'cloud', 'ws-blog', root)
  const metadataPath = join(created.path, '.dsh-remote.json')
  const conflicting = { version: 1, nodeId: 'other', workspaceId: 'ws-other', remoteCwd: '/srv/other' }
  await writeFile(metadataPath, JSON.stringify(conflicting), 'utf8')

  await assert.rejects(
    prepareMeshAnchor(runtimeFixture(), registry, 'cloud', 'ws-blog', root),
    /anchor metadata mismatch/,
  )
  assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), conflicting)
  assert.equal(createdCount, 1)
})

test('anchor preparation rejects an unknown target before touching the registry', async () => {
  let called = false
  const registry = { list: () => [], create: async () => { called = true; throw new Error('unreachable') } }
  await assert.rejects(prepareMeshAnchor(runtimeFixture(), registry, 'cloud', 'ws-missing', tmpdir()), /unknown workspace/)
  assert.equal(called, false)
})

test('anchor registration resolves a registry that appears after mounting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const routes: MeshFetchRoute[] = []
  let registry: AnchorWorkspaceRegistry | undefined
  const ctx: MeshRouteContext = {
    get: (name) => name === 'connection'
      ? { fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }
      : undefined,
  }
  const source = { get: (name: string) => name === 'workspaceRegistry' ? registry : undefined }
  registerMeshAnchorRoute(ctx as never, runtimeFixture(), source)
  const request = () => new Request('http://local/api/mesh/anchor', {
    method: 'POST',
    body: JSON.stringify({ nodeId: 'cloud', workspaceId: 'ws-blog' }),
  })

  const unavailable = await routes[0]!.fetch(request())
  assert.equal(unavailable.status, 503)

  registry = {
    list: () => [],
    create: async (path: string, title?: string) => ({ id: 'late-local-id', path, title: title ?? '', sessionIds: [] }),
  }
  const created = await routes[0]!.fetch(request())
  assert.equal(created.status, 200)
  const body = await created.json() as { ok?: boolean; workspace?: { workspaceId?: string } }
  assert.equal(body.ok, true)
  assert.equal(body.workspace?.workspaceId, 'late-local-id')
})

test('the anchor handler validates input and the route accepts POST only', async () => {
  const response = await handleAnchor(new Request('http://local', { method: 'POST', body: '{}' }), {
    runtime: runtimeFixture(), registry: undefined, root: tmpdir(),
  })
  assert.equal(response.status, 400)
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  assert.equal(mountMeshAnchorRoute(ctx, { runtime: runtimeFixture(), registry: undefined, root: tmpdir() }), true)
  assert.equal(routes[0]?.path, MESH_ANCHOR_PATH)
  assert.deepEqual(routes[0]?.methods, ['POST'])
})
