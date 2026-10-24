import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  EPOCH_MS,
  ReplayGuard,
  deriveEpochKey,
  epochOf,
  requestToken,
  verifyRequestToken,
} from '../src/identity/index.js'

const secretA = randomBytes(32)
const secretB = Buffer.from(secretA)
const secretC = randomBytes(32)

const now = 1_700_000_000_000
const epoch = epochOf(now)

test('epoch keys are deterministic per (secret, epoch)', () => {
  assert.deepEqual(deriveEpochKey(secretA, epoch), deriveEpochKey(secretB, epoch))
  assert.notDeepEqual(deriveEpochKey(secretA, epoch), deriveEpochKey(secretA, epoch + 1))
  assert.notDeepEqual(deriveEpochKey(secretA, epoch), deriveEpochKey(secretC, epoch))
})

test('rejects a short shared secret', () => {
  assert.throws(() => deriveEpochKey(randomBytes(8), epoch), /too short/)
})

test('both peers compute the same token without transmitting the secret', () => {
  const fp = { requestId: 'req-1', method: 'session/prompt', bodyHash: 'sha256:abc' }
  const token = requestToken(deriveEpochKey(secretA, epoch), fp)
  assert.equal(token, requestToken(deriveEpochKey(secretB, epoch), fp))
  assert.equal(verifyRequestToken(deriveEpochKey(secretA, epoch), fp, token), true)
  assert.ok(!token.includes(secretA.toString('base64url').slice(0, 8)))
})

test('tampered body, wrong peer and rotated epoch are all rejected', () => {
  const fp = { requestId: 'req-1', method: 'session/prompt', bodyHash: 'sha256:abc' }
  const token = requestToken(deriveEpochKey(secretA, epoch), fp)
  const key = deriveEpochKey(secretA, epoch)

  assert.equal(verifyRequestToken(key, { ...fp, bodyHash: 'tampered' }, token), false)
  assert.equal(verifyRequestToken(deriveEpochKey(secretC, epoch), fp, token), false)
  assert.equal(verifyRequestToken(deriveEpochKey(secretA, epoch + 1), fp, token), false)
})

test('replay guard accepts once, rejects replays and far-future epochs', () => {
  const guard = new ReplayGuard()
  assert.equal(guard.accept(epoch, 'req-1'), true)
  assert.equal(guard.accept(epoch, 'req-1'), false)
  assert.equal(guard.accept(epoch, 'req-2'), true)
  assert.equal(guard.accept(epoch + 1, 'req-3'), true, 'one epoch of clock skew is tolerated')
  assert.equal(guard.accept(epoch + 5, 'req-4'), false, 'epoch outside tolerance is rejected')
})

test('replay window does not grow without bound', () => {
  const guard = new ReplayGuard(2)
  for (let i = 0; i < 10; i += 1) guard.accept(epoch + i, `r-${i}`)
  // Older epochs are dropped, so the same id becomes acceptable again after the window.
  assert.equal(guard.accept(epoch + 10, 'r-9'), true)
})

test('epoch length is ten minutes', () => {
  assert.equal(EPOCH_MS, 600_000)
})
