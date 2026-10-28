import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { handleConfigSave, MESH_CONFIG_PATH, mountMeshConfigRoute } from '../src/api/config.js'
import type { MeshConfigControl } from '../src/api/config.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import { readConfigOverride, sanitizeOverride, writeConfigOverride } from '../src/config/store.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/index.js'

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-config-'))
}

function makeRuntime(config: Partial<MeshToolConfig> = {}): MeshToolRuntime {
  const runtime: MeshToolRuntime = {
    board: createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    config: {
      transportMode: 'auto',
      leaseMs: 900_000,
      dispatchTimeoutMs: 120_000,
      leaseOwner: 'mesh-lead',
      ...config,
    },
    now: () => 1_000,
  }
  return runtime
}

function post(body: unknown): Request {
  return new Request('http://dsh.internal/api/mesh/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function control(dir: string, runtime = makeRuntime()): MeshConfigControl {
  return { runtime, file: join(dir, 'mesh-config.json'), extras: () => ({ configFile: join(dir, 'mesh-config.json') }) }
}

test('sanitizeOverride accepts the six known keys and rejects everything else', () => {
  const good = sanitizeOverride({
    transport: 'loopback',
    peerBaseUrl: 'https://peer.example.com',
    assignmentFile: 'assignment.yml',
    leaseMs: 60_000,
    dispatchTimeoutMs: 1_000,
    leaseOwner: 'lead',
  })
  assert.deepEqual(good.problems, [])
  assert.deepEqual(good.value, {
    transport: 'loopback',
    peerBaseUrl: 'https://peer.example.com',
    assignmentFile: 'assignment.yml',
    leaseMs: 60_000,
    dispatchTimeoutMs: 1_000,
    leaseOwner: 'lead',
  })

  const bad = sanitizeOverride({ transport: 'carrier-pigeon', leaseMs: -1, leaseOwner: ' ', peerBaseUrl: 'ftp://x', secret: 1 })
  assert.equal(bad.problems.length, 5)
  assert.deepEqual(bad.value, {})
})

test('writeConfigOverride merges, persists and reads back', () => {
  const dir = workdir()
  try {
    const file = join(dir, 'nested', 'mesh-config.json')
    writeConfigOverride({ leaseMs: 1_000 }, file)
    const merged = writeConfigOverride({ leaseOwner: 'lead-2' }, file)
    assert.deepEqual(merged, { leaseMs: 1_000, leaseOwner: 'lead-2' })
    assert.deepEqual(readConfigOverride(file), { leaseMs: 1_000, leaseOwner: 'lead-2' })
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.leaseOwner, 'lead-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readConfigOverride ignores a malformed file', () => {
  const dir = workdir()
  try {
    const file = join(dir, 'mesh-config.json')
    writeConfigOverride({ leaseMs: 1_000 }, file)
    // Corrupt the file in place.
    writeFileSync(file, '{ not json', 'utf8')
    assert.deepEqual(readConfigOverride(file), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleConfigSave applies lease fields immediately and reports restart-only fields', async () => {
  const dir = workdir()
  try {
    const runtime = makeRuntime()
    const response = await handleConfigSave(post({
      leaseMs: 30_000,
      leaseOwner: 'ops',
      transport: 'loopback',
      peerBaseUrl: 'https://peer.example.com',
    }), control(dir, runtime))
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.deepEqual(body.applied, ['leaseMs', 'leaseOwner'])
    assert.deepEqual(body.pendingRestart, ['transport', 'peerBaseUrl'])
    assert.equal(runtime.config.leaseMs, 30_000)
    assert.equal(runtime.config.leaseOwner, 'ops')
    assert.equal(runtime.config.transportMode, 'loopback')
    const state = body.state as Record<string, any>
    assert.equal(state.config.leaseMs, 30_000)
    assert.equal(state.config.peerBaseUrl, '')
    assert.equal(readConfigOverride(join(dir, 'mesh-config.json')).peerBaseUrl, 'https://peer.example.com')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleConfigSave hot-loads an assignment file and rejects a broken one', async () => {
  const dir = workdir()
  try {
    const runtime = makeRuntime()
    const assignment = join(dir, 'assignment.yml')
    writeFileSync(assignment, 'nodes:\n  node-a: { label: Node A, endpoint: mock://a }\nassignments:\n  - { workspaceId: ws-1, nodeId: node-a }\n', 'utf8')

    const ok = await handleConfigSave(post({ assignmentFile: assignment }), control(dir, runtime))
    assert.equal(ok.status, 200)
    const okBody = (await ok.json()) as Record<string, any>
    assert.deepEqual(okBody.applied, ['assignmentFile'])
    assert.equal(runtime.assignment?.file, assignment)
    assert.equal(okBody.state.assignment.configured, true)
    assert.equal(okBody.state.peers.length, 1)

    const missing = await handleConfigSave(post({ assignmentFile: join(dir, 'missing.yml') }), control(dir, runtime))
    assert.equal(missing.status, 400)
    assert.match(String(((await missing.json()) as Record<string, unknown>).error), /missing.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleConfigSave rejects invalid patches without touching the runtime', async () => {
  const dir = workdir()
  try {
    const runtime = makeRuntime()
    const invalid = await handleConfigSave(post({ leaseMs: 'soon' }), control(dir, runtime))
    assert.equal(invalid.status, 400)
    const unknown = await handleConfigSave(post({ nope: 1 }), control(dir, runtime))
    assert.equal(unknown.status, 400)
    const empty = await handleConfigSave(post({}), control(dir, runtime))
    assert.equal(empty.status, 400)
    assert.equal(runtime.config.leaseMs, 900_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mountMeshConfigRoute registers POST /api/mesh/config on connection.fetch', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = {
    get: (name) => (name === 'connection' ? { fetch: { register(route: MeshFetchRoute) { routes.push(route); return () => {} } } } : undefined),
  }
  const dir = workdir()
  try {
    assert.equal(mountMeshConfigRoute(ctx, control(dir)), true)
    assert.equal(routes.length, 1)
    assert.equal(routes[0]?.path, MESH_CONFIG_PATH)
    assert.deepEqual(routes[0]?.methods, ['POST'])
    assert.equal(routes[0]?.requestBody, 'buffered')
    assert.match(MESH_CONFIG_PATH, /^\/api\/mesh\//u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
