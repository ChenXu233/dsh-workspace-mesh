import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MESH_TOKEN_TTL_MS,
  mintMeshToken,
  NonceCache,
  signHandshake,
  verifyHandshake,
  verifyMeshToken,
} from '../src/api/mesh-auth.js'

/** The mesh credential must be unforgeable, short-lived and replay-proof. */

test('a minted token verifies and carries its claims', () => {
  const token = mintMeshToken('s3cret', { nodeId: 'peer-a', expiresAt: 2_000 })
  const check = verifyMeshToken('s3cret', token, 1_000)
  assert.equal(check.ok, true)
  assert.deepEqual(check.ok === true ? check.claims : undefined, { nodeId: 'peer-a', expiresAt: 2_000 })
})

test('a token is refused after it expires', () => {
  const token = mintMeshToken('s3cret', { nodeId: 'peer-a', expiresAt: 2_000 })
  const check = verifyMeshToken('s3cret', token, 2_001)
  assert.equal(check.ok, false)
  assert.equal(check.ok === false ? check.reason : undefined, 'expired')
})

test('a tampered or foreign token is refused', () => {
  const token = mintMeshToken('s3cret', { nodeId: 'peer-a', expiresAt: 9_000 })
  assert.equal(verifyMeshToken('other', token, 1_000).ok, false)
  const [payload, signature] = token.split('.')
  assert.equal(verifyMeshToken('s3cret', `${payload}x.${signature}`, 1_000).ok, false)
  assert.equal(verifyMeshToken('s3cret', 'not-a-token', 1_000).ok, false)
})

test('a handshake verifies once and refuses replays', () => {
  const nonces = new NonceCache(60_000)
  const now = 1_000_000
  const body = { nodeId: 'peer-a', ts: now, nonce: 'abcdefgh' }
  const signed = { ...body, hmac: signHandshake('s3cret', body) }
  assert.deepEqual(verifyHandshake('s3cret', signed, nonces, now), { ok: true })
  const replay = verifyHandshake('s3cret', signed, nonces, now)
  assert.equal(replay.ok, false)
  assert.equal(replay.ok === false ? replay.reason : undefined, 'nonce-reused')
})

test('a handshake outside the clock window or with a bad signature is refused', () => {
  const body = { nodeId: 'peer-a', ts: 1_000_000, nonce: 'abcdefgh' }
  const signed = { ...body, hmac: signHandshake('s3cret', body) }
  const stale = verifyHandshake('s3cret', signed, new NonceCache(), 1_000_000 + 120_000)
  assert.equal(stale.ok === false ? stale.reason : undefined, 'stale')
  const forged = { ...signed, hmac: signHandshake('other', body) }
  const bad = verifyHandshake('s3cret', forged, new NonceCache(), 1_000_000)
  assert.equal(bad.ok === false ? bad.reason : undefined, 'signature')
  assert.equal(verifyHandshake('s3cret', null, new NonceCache(), 1_000_000).ok, false)
})

test('the default token lifetime is short', () => {
  assert.ok(MESH_TOKEN_TTL_MS <= 15 * 60 * 1000)
})
