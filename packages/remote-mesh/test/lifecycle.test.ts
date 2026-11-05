import assert from 'node:assert/strict'
import test from 'node:test'
import { createSelfRestartController, detectSupervisor } from '../src/lifecycle/index.js'

test('status reports pid, start time and supervisor', () => {
  const c = createSelfRestartController({ pid: 42, now: () => 1_000, exit: () => {} })
  const s = c.status()
  assert.equal(s.pid, 42)
  assert.equal(s.startedAt, 1_000)
  assert.equal(s.state, 'running')
  assert.ok(['systemd', 'docker', 'pm2', 'unknown'].includes(s.supervisor))
})

test('requestRestart drains once and exits exactly once', async () => {
  const exits: number[] = []
  let drains = 0
  const c = createSelfRestartController({ exit: (code) => exits.push(code), drainTimeoutMs: 50 })

  c.onDrain(() => { drains += 1 })
  c.requestRestart('unit-test')
  assert.equal(c.status().state, 'draining')

  // Idempotent: a second request must not queue a second exit.
  c.requestRestart('again')

  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.deepEqual(exits, [0])
  assert.equal(drains, 1)
  assert.equal(c.status().state, 'offline')
})

test('drain timeout still exits', async () => {
  const exits: number[] = []
  const c = createSelfRestartController({ exit: (code) => exits.push(code), drainTimeoutMs: 30 })
  c.onDrain(() => new Promise<void>(() => {}))   // never resolves
  c.requestRestart('hangs')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(exits, [0])
})

test('detectSupervisor always returns a known value', () => {
  const known = ['systemd', 'docker', 'pm2', 'unknown']
  assert.ok(known.includes(detectSupervisor()))
})
