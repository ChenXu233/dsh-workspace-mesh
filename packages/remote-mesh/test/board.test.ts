import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInMemoryBoard } from '../src/board/index.js'
import type { Task, TaskState } from '../src/types.js'

function makeTask(taskId: string, nodeId = 'node-a', state: TaskState = 'queued'): Task {
  return {
    taskId,
    target: { nodeId, workspaceId: 'ws-' + nodeId },
    objective: 'do ' + taskId,
    policy: { sessionMode: 'new', replyMode: 'final' },
    lease: { owner: '', fencingToken: 0, expiresAt: 0 },
    state,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

test('a live lease rejects another owner without changing the lease', () => {
  let clock = 1_000
  const board = createInMemoryBoard(() => clock)

  assert.equal(board.create(makeTask('t-1')), true)
  assert.equal(board.create(makeTask('t-1')), false, 'duplicate task ids are rejected, never clobbered')

  assert.equal(board.claim('t-1', 'lead', 100), true)
  const claimed = board.get('t-1')
  assert.ok(claimed)
  assert.equal(claimed.lease.owner, 'lead')
  assert.equal(claimed.lease.expiresAt, 1_100)

  clock = 1_050
  assert.equal(board.claim('t-1', 'intruder', 100), false, 'a live lease cannot be stolen')

  const after = board.get('t-1')
  assert.ok(after)
  assert.equal(after.lease.owner, 'lead')
  assert.equal(after.lease.fencingToken, claimed.lease.fencingToken)
  assert.equal(after.lease.expiresAt, 1_100, 'a rejected claim must not extend the lease')
  assert.equal(board.claim('t-missing', 'lead', 100), false, 'unknown tasks cannot be claimed')
})

test('renewing your own live lease keeps the fencing token and extends the expiry', () => {
  let clock = 1_000
  const board = createInMemoryBoard(() => clock)
  board.create(makeTask('t-1'))

  assert.equal(board.claim('t-1', 'lead', 100), true)
  const token = board.get('t-1')!.lease.fencingToken

  clock = 1_050
  assert.equal(board.claim('t-1', 'lead', 100), true)
  const renewed = board.get('t-1')!.lease
  assert.equal(renewed.fencingToken, token, 'renewal is not a new fencing epoch')
  assert.equal(renewed.expiresAt, 1_150)
})

test('an expired lease can be taken over and the fencing token strictly increases', () => {
  let clock = 1_000
  const board = createInMemoryBoard(() => clock)
  board.create(makeTask('t-1'))

  assert.equal(board.claim('t-1', 'lead', 100), true) // expires at 1_100
  const tokens = [board.get('t-1')!.lease.fencingToken]

  clock = 1_099
  assert.equal(board.claim('t-1', 'other', 100), false, 'still live one millisecond before expiry')

  clock = 1_100
  assert.equal(board.claim('t-1', 'other', 100), true, 'at the expiry instant the lease is stealable')
  tokens.push(board.get('t-1')!.lease.fencingToken)
  assert.equal(board.get('t-1')!.lease.owner, 'other')

  clock = 1_250
  assert.equal(board.claim('t-1', 'third', 100), true)
  tokens.push(board.get('t-1')!.lease.fencingToken)

  for (let i = 1; i < tokens.length; i += 1) {
    assert.ok(tokens[i]! > tokens[i - 1]!, 'fencing token must strictly increase across takeovers')
  }
  assert.equal(board.get('t-1')!.lease.owner, 'third')
})

test('release frees the lease and a later claim opens a new fencing epoch', () => {
  let clock = 1_000
  const board = createInMemoryBoard(() => clock)
  board.create(makeTask('t-1'))

  board.claim('t-1', 'lead', 100)
  const first = board.get('t-1')!.lease.fencingToken

  assert.equal(board.release('t-1', 'intruder'), false, 'only the owner may release')
  assert.equal(board.get('t-1')!.lease.owner, 'lead')

  assert.equal(board.release('t-1', 'lead'), true)
  const released = board.get('t-1')!.lease
  assert.equal(released.owner, '')
  assert.equal(released.expiresAt, 0)
  assert.equal(released.fencingToken, first, 'release itself does not mint a token')

  clock = 1_010
  assert.equal(board.claim('t-1', 'other', 100), true, 'a released task can be claimed again')
  assert.ok(board.get('t-1')!.lease.fencingToken > first, 're-claim opens a new fencing epoch')
  assert.equal(board.get('t-1')!.lease.owner, 'other')
  assert.equal(board.release('t-missing'), false, 'unknown tasks cannot be released')
})

test('list filters by state and nodeId', () => {
  const board = createInMemoryBoard(() => 1_000)
  board.create(makeTask('t-1', 'node-a', 'queued'))
  board.create(makeTask('t-2', 'node-b', 'queued'))
  board.create(makeTask('t-3', 'node-a', 'running'))
  board.create(makeTask('t-4', 'node-a', 'done'))

  const ids = (filter?: Parameters<typeof board.list>[0]): string[] =>
    board.list(filter).map((task) => task.taskId).sort()

  assert.deepEqual(ids(), ['t-1', 't-2', 't-3', 't-4'])
  assert.deepEqual(ids({ state: 'queued' }), ['t-1', 't-2'])
  assert.deepEqual(ids({ state: 'running' }), ['t-3'])
  assert.deepEqual(ids({ state: 'done' }), ['t-4'])
  assert.deepEqual(ids({ nodeId: 'node-a' }), ['t-1', 't-3', 't-4'])
  assert.deepEqual(ids({ nodeId: 'node-b' }), ['t-2'])
  assert.deepEqual(ids({ state: 'queued', nodeId: 'node-a' }), ['t-1'])
  assert.deepEqual(ids({ state: 'failed' }), [])
  assert.deepEqual(ids({ nodeId: 'node-z' }), [])
})

test('update patches non-lease fields and returned tasks are defensive copies', () => {
  const board = createInMemoryBoard(() => 1_000)
  board.create(makeTask('t-1'))

  assert.equal(board.update('t-1', { state: 'dispatched', objective: 'changed' }), true)
  const task = board.get('t-1')!
  assert.equal(task.state, 'dispatched')
  assert.equal(task.objective, 'changed')
  assert.equal(task.updatedAt, 1_000, 'update stamps updatedAt from the injected clock')

  task.lease.owner = 'hacked'
  task.state = 'done'
  assert.equal(board.get('t-1')!.lease.owner, '', 'mutating a copy cannot corrupt the board')
  assert.equal(board.get('t-1')!.state, 'dispatched')

  board.claim('t-1', 'lead', 100)
  const token = board.get('t-1')!.lease.fencingToken
  board.update('t-1', { lease: { owner: 'intruder', fencingToken: 99, expiresAt: 9_999 } })
  const guarded = board.get('t-1')!.lease
  assert.equal(guarded.owner, 'lead', 'update cannot rewrite the lease')
  assert.equal(guarded.fencingToken, token)

  assert.equal(board.update('t-missing', { state: 'done' }), false)
})

test('claim rejects a non-positive ttl and an empty owner', () => {
  const board = createInMemoryBoard(() => 1_000)
  board.create(makeTask('t-1'))

  assert.throws(() => board.claim('t-1', 'lead', 0), RangeError)
  assert.throws(() => board.claim('t-1', 'lead', -5), RangeError)
  assert.throws(() => board.claim('t-1', 'lead', Number.POSITIVE_INFINITY), RangeError)
  assert.throws(() => board.claim('t-1', '', 100), /owner/)
  assert.equal(board.get('t-1')!.lease.owner, '', 'a rejected claim leaves the task untouched')
})

test('the board module has zero package imports and never spawns a process', () => {
  const source = readFileSync(new URL('../../src/board/index.ts', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!)
  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('.'), 'board may only import local modules, found: ' + specifier)
  }
  for (const token of ['node:http', 'node:net', 'node:child_process', 'spawn(', 'exec(', 'fetch(']) {
    assert.equal(source.includes(token), false, 'board must not reference ' + token)
  }
})
