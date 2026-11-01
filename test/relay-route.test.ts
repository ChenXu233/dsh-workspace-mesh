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

/**
 * Mirrors `ctx.sessionController` as the host declares it: every operation that
 * touches the log calls `signal.throwIfAborted()` first, and `create` takes no
 * signal. A relay that passes the wrong thing in that position fails here
 * instead of only on a real peer.
 */
function controller(calls: string[], seen: Record<string, unknown> = {}): SessionControllerLike {
  const needSignal = (method: string, signal: AbortSignal | undefined): AbortSignal => {
    if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
      throw new TypeError(`${method}: signal.throwIfAborted is not a function`)
    }
    return signal
  }
  return {
    list: async (request, signal) => {
      needSignal('list', signal)
      seen.list = request
      return { items: [{ sessionId: 's1' }] }
    },
    create: async (request) => {
      seen.create = request
      return { sessionId: 'session-new' }
    },
    prompt: async (request, signal) => {
      needSignal('prompt', signal)
      seen.prompt = request
      calls.push(String((request as { sessionId?: string }).sessionId))
      return { accepted: true }
    },
    page: async (request, signal) => {
      needSignal('page', signal)
      seen.page = request
      return { records: [], hasMore: false }
    },
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

test('the relay calls the controller with the host\'s own signatures', async () => {
  const now = 1_000_000
  const handshake = await handleHandshake(post(MESH_HANDSHAKE_PATH, signed('peer-a', now)), { secret: () => SECRET, nonces: new NonceCache(), now: () => now })
  const minted = (await handshake.json()) as { token: string }
  const calls: string[] = []
  const seen: Record<string, unknown> = {}
  const control = { secret: () => SECRET, controller: () => controller(calls, seen), now: () => now }

  const ops: Array<[string, Record<string, unknown>]> = [
    ['list', { _request: {} }],
    ['create', { request: { workspaceId: 'ws-1' } }],
    ['page', { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 7 } }],
    ['prompt', { request: { requestId: 'r1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } }],
  ]
  for (const [op, args] of ops) {
    const response = await handleRelay(post(MESH_RELAY_PATH, { token: minted.token, op, args }), control)
    assert.equal(response.status, 200, `${op} must reach the controller`)
    const body = (await response.json()) as { ok: boolean; error?: string }
    assert.equal(body.ok, true, `${op}: ${body.error ?? ''}`)
  }
  // The payload travels unchanged: the relay unwraps the RPC envelope, nothing more.
  assert.deepEqual(seen.list, {})
  assert.deepEqual(seen.create, { workspaceId: 'ws-1' })
  assert.deepEqual(seen.page, { address: { kind: 'session', sessionId: 's1' }, throughSeq: 7 })
  assert.deepEqual(seen.prompt, { requestId: 'r1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
  assert.deepEqual(calls, ['s1'])
})

