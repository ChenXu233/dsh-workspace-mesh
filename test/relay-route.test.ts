import assert from 'node:assert/strict'
import test from 'node:test'

import { handleHandshake, MESH_HANDSHAKE_PATH, mountMeshHandshakeRoute } from '../src/api/handshake.js'
import { NonceCache, signHandshake } from '../src/api/mesh-auth.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { handleRelay, MESH_RELAY_PATH, mountMeshRelayRoute } from '../src/api/relay.js'
import type { SessionControllerLike } from '../src/api/relay.js'

/** A paired peer recovers by itself: handshake for a token, relay to work. */

const SECRET = 'shared-secret'

function post(path: string, body: unknown): Request {
  return new Request('http://dsh.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function signed(nodeId: string, now: number, nonce = 'nonce-1234') {
  const base = { nodeId, ts: now, nonce }
  return { ...base, hmac: signHandshake(SECRET, base) }
}

function controller(calls: string[]): SessionControllerLike {
  return {
    list: async () => ({ items: [{ sessionId: 's1' }] }),
    create: async (request) => ({ sessionId: 'session-new', request }),
    prompt: async (request) => { calls.push(String((request as { sessionId?: string }).sessionId)); return { accepted: true } },
    page: async () => ({ records: [], hasMore: false }),
  }
}

test('a signed handshake mints a token the relay accepts', async () => {
  const now = 1_000_000
  const handshake = await handleHandshake(post(MESH_HANDSHAKE_PATH, signed('peer-a', now)), {
    secret: () => SECRET,
    nonces: new NonceCache(),
    now: () => now,
  })
  assert.equal(handshake.status, 200)
  const minted = (await handshake.json()) as { ok: boolean; token: string; expiresAt: number }
  assert.equal(minted.ok, true)
  assert.ok(minted.expiresAt > now)

  const calls: string[] = []
  const relay = await handleRelay(post(MESH_RELAY_PATH, { token: minted.token, op: 'prompt', args: { request: { requestId: 'r1', sessionId: 's1' } } }), {
    secret: () => SECRET,
    controller: () => controller(calls),
    now: () => now,
  })
  assert.equal(relay.status, 200)
  const result = (await relay.json()) as { ok: boolean; value: { accepted: boolean } }
  assert.equal(result.ok, true)
  assert.equal(result.value.accepted, true)
  assert.deepEqual(calls, ['s1'], 'the prompt reached the local controller')
})

test('the relay refuses a missing, foreign or expired token', async () => {
  const now = 1_000_000
  const control = { secret: () => SECRET, controller: () => controller([]), now: () => now }
  assert.equal((await handleRelay(post(MESH_RELAY_PATH, { op: 'list' }), control)).status, 401)
  assert.equal((await handleRelay(post(MESH_RELAY_PATH, { token: 'a.b', op: 'list' }), control)).status, 401)

  const handshake = await handleHandshake(post(MESH_HANDSHAKE_PATH, signed('peer-a', now)), { secret: () => SECRET, nonces: new NonceCache(), now: () => now })
  const minted = (await handshake.json()) as { token: string }
  const later = now + 11 * 60 * 1000
  assert.equal((await handleRelay(post(MESH_RELAY_PATH, { token: minted.token, op: 'list' }), { ...control, now: () => later })).status, 401)
})

test('the relay only serves the four session operations plus workspaces', async () => {
  const now = 1_000_000
  const handshake = await handleHandshake(post(MESH_HANDSHAKE_PATH, signed('peer-a', now)), { secret: () => SECRET, nonces: new NonceCache(), now: () => now })
  const minted = (await handshake.json()) as { token: string }
  const control = { secret: () => SECRET, controller: () => controller([]), now: () => now }
  const unknown = await handleRelay(post(MESH_RELAY_PATH, { token: minted.token, op: 'exec' }), control)
  assert.equal(unknown.status, 400)
  const workspaces = await handleRelay(post(MESH_RELAY_PATH, { token: minted.token, op: 'workspaces' }), { ...control, workspaces: () => ({ ok: true, workspaces: [] }) })
  assert.equal(workspaces.status, 200)
})

test('without a configured secret both routes refuse instead of opening up', async () => {
  const now = 1_000_000
  assert.equal((await handleHandshake(post(MESH_HANDSHAKE_PATH, signed('peer-a', now)), { secret: () => undefined, nonces: new NonceCache(), now: () => now })).status, 503)
  assert.equal((await handleRelay(post(MESH_RELAY_PATH, { token: 'x.y', op: 'list' }), { secret: () => '', controller: () => controller([]) })).status, 503)
})

test('both routes mount on their exact paths with POST', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  assert.equal(mountMeshHandshakeRoute(ctx, { secret: () => SECRET, nonces: new NonceCache() }), true)
  assert.equal(mountMeshRelayRoute(ctx, { secret: () => SECRET, controller: () => controller([]) }), true)
  assert.deepEqual(routes.map((route) => [route.path, route.methods]), [[MESH_HANDSHAKE_PATH, ['POST']], [MESH_RELAY_PATH, ['POST']]])
})
