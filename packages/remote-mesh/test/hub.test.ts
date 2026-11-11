import assert from 'node:assert/strict'
import test from 'node:test'

import { handleHubForward, handleHubInbox, handleHubJoin, handleHubNodes, handleHubResult } from '../src/api/hub.js'
import { decodeHubPayload, encodeHubPayload, handleHubAdopt, handleHubLink, HUB_PAYLOAD_VERSION } from '../src/api/hub-link.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/types.js'
import type { MeshHubControl } from '../src/api/hub.js'
import { HubAgent } from '../src/hub/agent.js'
import { HubRegistry } from '../src/hub/registry.js'
import { MESH_TOKEN_TTL_MS, mintMeshToken } from '../src/api/mesh-auth.js'

const SECRET = 'hub-secret'
const NOW = 1_000_000

function control(registry: HubRegistry): MeshHubControl {
  return { secret: () => SECRET, registry, now: () => NOW }
}

function token(nodeId: string, expiresAt: number = NOW + MESH_TOKEN_TTL_MS): string {
  return mintMeshToken(SECRET, { nodeId, expiresAt })
}

function post(path: string, body: unknown, query = ''): Request {
  return new Request('http://hub.internal' + path + query, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get(path: string, query: string): Request {
  return new Request('http://hub.internal' + path + query)
}

test('a joining node is handed the directory and everyone else sees it', async () => {
  const registry = new HubRegistry(() => NOW)
  const first = await handleHubJoin(post('/api/mesh/hub/join', {
    token: token('a'), nodeId: 'a', url: 'http://a:3211',
  }), control(registry))
  const firstBody = (await first.json()) as Record<string, any>
  assert.equal(firstBody.ok, true)
  assert.deepEqual(firstBody.peers, [])

  const second = await handleHubJoin(post('/api/mesh/hub/join', {
    token: token('b'), nodeId: 'b',
  }), control(registry))
  const secondBody = (await second.json()) as Record<string, any>
  assert.deepEqual(secondBody.peers.map((node: any) => node.nodeId), ['a'])
  // A relay-only node advertises no address; the directory keeps it anyway.
  assert.equal(secondBody.peers[0].url, 'http://a:3211')

  const nodes = await handleHubNodes(get('/api/mesh/hub/nodes', '?token=' + encodeURIComponent(token('a'))), control(registry))
  const nodesBody = (await nodes.json()) as Record<string, any>
  assert.deepEqual(nodesBody.nodes.map((node: any) => node.nodeId).sort(), ['a', 'b'])
})

test('a bad hub token is refused with 401', async () => {
  const registry = new HubRegistry(() => NOW)
  const response = await handleHubJoin(post('/api/mesh/hub/join', {
    token: mintMeshToken('other-secret', { nodeId: 'a', expiresAt: NOW + 1000 }),
    nodeId: 'a',
  }), control(registry))
  assert.equal(response.status, 401)
  assert.equal(registry.size(), 0)
})

test('a forward waits for the node and returns its answer', async () => {
  const registry = new HubRegistry(() => NOW)
  registry.join({ nodeId: 'b', url: '' })
  const pending = handleHubForward(post('/api/mesh/hub/forward', {
    token: token('a'),
    method: 'POST',
    path: '/api/mesh/relay',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{}').toString('base64'),
  }, '?nodeId=b'), 'b', control(registry))

  // The node polls, runs it, and posts the result back.
  const taken = await registry.take('b', 50)
  assert.notEqual(taken, undefined)
  assert.equal(taken?.envelope.path, '/api/mesh/relay')
  const answered = await handleHubResult(post('/api/mesh/hub/result', {
    token: token('b'),
    id: taken?.id,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"ok":true}').toString('base64'),
  }), control(registry))
  assert.deepEqual((await answered.json()) as Record<string, any>, { ok: true, delivered: true })

  const response = await pending
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.result.status, 200)
  assert.equal(Buffer.from(body.result.body, 'base64').toString('utf8'), '{"ok":true}')
})

test('the inbox reports an empty poll and the directory', async () => {
  const registry = new HubRegistry(() => NOW)
  registry.join({ nodeId: 'a', url: 'http://a:3211' })
  const response = await handleHubInbox(get('/api/mesh/hub/inbox', '?token=' + encodeURIComponent(token('a')) + '&nodeId=a&wait=0'), control(registry))
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.job, null)
  assert.deepEqual(body.nodes.map((node: any) => node.nodeId), ['a'])
})

test('forwarding to a node that never answers times out instead of hanging', async () => {
  const registry = new HubRegistry(() => NOW)
  registry.join({ nodeId: 'b', url: '' })
  await assert.rejects(
    registry.enqueue('b', { method: 'GET', path: '/x', headers: {} }, 20),
    /did not answer/,
  )
})

test('forwarding to an unknown node is refused up front', async () => {
  const registry = new HubRegistry(() => NOW)
  await assert.rejects(registry.enqueue('ghost', { method: 'GET', path: '/x', headers: {} }, 20), /unknown hub node/)
})

test('the agent joins, takes a delivery, runs it locally and answers', async () => {
  const registry = new HubRegistry(() => NOW)
  registry.join({ nodeId: 'hub-node', url: '' })
  const deliveries: Array<{ path: string, method: string }> = []
  const calls: string[] = []

  // Serve the hub's three endpoints from the registry, without a socket.
  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.pathname === '/api/mesh/hub/join') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const joined = registry.join({ nodeId: body.nodeId, url: body.url })
      return new Response(JSON.stringify({ ok: true, node: joined.node, peers: joined.peers }), { status: 200 })
    }
    if (url.pathname === '/api/mesh/hub/inbox') {
      const nodeId = url.searchParams.get('nodeId') ?? ''
      const job = await registry.take(nodeId, 5)
      // Same flattening the real route does.
      const wire = job === undefined ? null : { id: job.id, ...job.envelope }
      return new Response(JSON.stringify({ ok: true, job: wire, nodes: registry.directory() }), { status: 200 })
    }
    if (url.pathname === '/api/mesh/hub/result') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      registry.settle(body.id, { status: body.status, headers: body.headers, body: body.body })
      return new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch

  const agent = new HubAgent({
    hubUrl: 'http://hub.internal',
    nodeId: 'b',
    publicUrl: () => '',
    secret: () => SECRET,
    waitMs: 5,
    retryMs: 5,
    now: () => NOW,
    fetchImpl,
    dispatch: async (delivery) => {
      deliveries.push({ path: delivery.path, method: delivery.method })
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}').toString('base64') }
    },
  })
  agent.start()
  try {
    // Once the agent has joined, a forward must reach it and come back.
    await new Promise(resolve => setTimeout(resolve, 30))
    const answer = await registry.enqueue('b', { method: 'POST', path: '/api/mesh/relay', headers: {} }, 500)
    assert.equal(answer.status, 200)
    assert.deepEqual(deliveries, [{ path: '/api/mesh/relay', method: 'POST' }])
    assert.deepEqual(calls.slice(0, 2), ['/api/mesh/hub/join', '/api/mesh/hub/inbox'])
  } finally {
    await agent.stop()
  }
})

function linkControl(overrides: Partial<{ secret: string, publicUrl: string, hub: { url: string } }> = {}) {
  const state = { secret: overrides.secret ?? '', publicUrl: overrides.publicUrl ?? '', hub: overrides.hub }
  const config: MeshToolConfig = { transportMode: 'auto', leaseMs: 900_000, dispatchTimeoutMs: 5_000, leaseOwner: 'lead' }
  const runtime: MeshToolRuntime = {
    board: createInMemoryBoard(() => NOW),
    lifecycle: createSelfRestartController({ now: () => NOW, exit: () => {} }),
    transport: undefined,
    config,
  }
  return {
    state,
    control: {
      runtime,
      file: '/nonexistent/mesh-config.json',
      secret: () => state.secret,
      setSecret: (next: string) => { state.secret = next },
      publicUrl: () => state.publicUrl,
      setHub: (hub: { url: string }) => { state.hub = hub },
    },
  }
}

test('a join link carries the hub url, its secret and a node name', async () => {
  const { state, control } = linkControl({ publicUrl: 'https://hub.example' })
  const response = await handleHubLink(new Request('http://hub.internal/api/mesh/hub-link'), control)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.url, 'https://hub.example')
  assert.match(body.link, /^https:\/\/hub\.example\/#mesh-hub=/)
  // A node with no secret mints one on first use, and that is what the link carries.
  assert.match(state.secret, /^mesh-/)
  assert.equal('secret' in body, false)
  const decoded = decodeHubPayload(body.link)
  assert.equal('error' in decoded, false)
  assert.equal((decoded as Record<string, any>).secret, state.secret)
  assert.equal((decoded as Record<string, any>).url, 'https://hub.example')
})

test('a join payload this build cannot read is refused', () => {
  assert.deepEqual(decodeHubPayload(''), { error: 'hub token is empty' })
  assert.equal('error' in decodeHubPayload(encodeHubPayload({ v: 99, url: 'http://a', secret: 's', nodeId: 'a' })), true)
  assert.equal('error' in decodeHubPayload(encodeHubPayload({ v: HUB_PAYLOAD_VERSION, url: 'ftp://a', secret: 's', nodeId: 'a' })), true)
  assert.equal('error' in decodeHubPayload(encodeHubPayload({ v: HUB_PAYLOAD_VERSION, url: 'http://a', secret: '', nodeId: 'a' })), true)
})

test('adopting a join link writes the hub and the shared secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-hub-adopt-'))
  const file = join(dir, 'mesh-config.json')
  const { state, control } = linkControl()
  const token = encodeHubPayload({ v: HUB_PAYLOAD_VERSION, url: 'https://hub.example/', secret: 'mesh-shared', nodeId: 'hub' })
  try {
    const response = await handleHubAdopt(post('/api/mesh/hub-adopt', { token }), { ...control, file })
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.ok, true)
    assert.deepEqual(body.hub, { url: 'https://hub.example' })
    assert.equal(state.secret, 'mesh-shared')
    assert.deepEqual(state.hub, { url: 'https://hub.example' })
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>
    assert.deepEqual(written.hub, { url: 'https://hub.example' })
    assert.equal(written.meshSecret, 'mesh-shared')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})