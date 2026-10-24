import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createMockTransport, MockTransportError } from '../src/transport/mock.js'
import type { MockTransportOptions } from '../src/transport/mock.js'
import type { MeshTransport } from '../src/transport/types.js'

function hasCode(code: string) {
  return (err: unknown): boolean => err instanceof MockTransportError && err.code === code
}

function seedTransport(options: Partial<MockTransportOptions> = {}) {
  return createMockTransport({
    now: () => 1_000,
    nodes: [
      {
        nodeId: 'node-a',
        label: 'Node A',
        endpoint: 'mock://a',
        workspaces: [{ workspaceId: 'ws-1', name: 'One', path: '/w/1' }],
      },
      {
        nodeId: 'node-b',
        label: 'Node B',
        online: false,
        workspaces: [{ workspaceId: 'ws-2', sessions: [{ sessionId: 's-legacy', title: 'legacy' }] }],
      },
    ],
    ...options,
  })
}

test('mock transport satisfies MeshTransport and reports kind mock', () => {
  const transport: MeshTransport = createMockTransport()
  assert.equal(transport.kind, 'mock', 'the typed assignment proves all five methods exist')
})

test('listNodes returns the injected roster with workspaces and online flags', async () => {
  const mesh = seedTransport()
  const nodes = await mesh.listNodes()

  assert.deepEqual(nodes.map((node) => node.nodeId), ['node-a', 'node-b'])
  const a = nodes[0]!
  assert.equal(a.label, 'Node A')
  assert.equal(a.endpoint, 'mock://a')
  assert.equal(a.online, true)
  assert.equal(a.lastSeenAt, 1_000)
  assert.deepEqual(a.workspaces.map((w) => w.workspaceId), ['ws-1'])
  assert.equal(a.workspaces[0]!.path, '/w/1')

  const b = nodes[1]!
  assert.equal(b.online, false, 'an offline node stays in the roster (SPEC 5.4)')
  assert.deepEqual(b.workspaces[0]!.sessions.map((s) => s.sessionId), ['s-legacy'])

  a.workspaces[0]!.name = 'mutated'
  const again = await mesh.listNodes()
  assert.equal(again[0]!.workspaces[0]!.name, 'One', 'descriptors are copies of the injected state')
})

test('listWorkspaces only exposes the requested node workspaces', async () => {
  const mesh = seedTransport()

  const a = await mesh.listWorkspaces('node-a')
  assert.deepEqual(a.map((w) => w.workspaceId), ['ws-1'])

  const b = await mesh.listWorkspaces('node-b')
  assert.deepEqual(b.map((w) => w.workspaceId), ['ws-2'])

  await assert.rejects(() => mesh.listWorkspaces('node-z'), hasCode('unknown-node'))
})

test('createSession returns deterministic ids and registers the session', async () => {
  const mesh = seedTransport({ sessionIdPrefix: 'sess' })

  const first = await mesh.createSession('node-a', 'ws-1')
  const second = await mesh.createSession('node-a', 'ws-1')
  assert.equal(first, 'sess-1')
  assert.equal(second, 'sess-2')

  const [workspace] = await mesh.listWorkspaces('node-a')
  assert.deepEqual(workspace!.sessions.map((s) => s.sessionId), ['sess-1', 'sess-2'])
  assert.equal(workspace!.sessions[0]!.title, 'mock session 1')

  await assert.rejects(() => mesh.createSession('node-a', 'ws-unknown'), hasCode('unknown-workspace'))
  await assert.rejects(() => mesh.createSession('node-b', 'ws-2'), hasCode('node-offline'))
  await assert.rejects(() => mesh.createSession('node-z', 'ws-1'), hasCode('unknown-node'))
})

test('prompt records text per session and rejects unknown sessions', async () => {
  const mesh = seedTransport()
  const sessionId = await mesh.createSession('node-a', 'ws-1')

  await mesh.prompt('node-a', sessionId, 'hello')
  await mesh.prompt('node-a', sessionId, 'again')
  assert.deepEqual(mesh.prompts('node-a', sessionId), ['hello', 'again'])

  await assert.rejects(() => mesh.prompt('node-a', 'nope', 'x'), hasCode('unknown-session'))
  await assert.rejects(() => mesh.prompt('node-z', sessionId, 'x'), hasCode('unknown-node'))
})

test('follow replays history, streams live events, and stops after unsubscribe', async () => {
  const mesh = seedTransport()
  const sessionId = await mesh.createSession('node-a', 'ws-1')

  mesh.emit('node-a', sessionId, { type: 'assistant/message', text: 'before' })
  const seen: unknown[] = []
  const off = await mesh.follow('node-a', sessionId, (event) => seen.push(event))

  assert.equal(mesh.followerCount('node-a', sessionId), 1)
  assert.deepEqual(seen, [{ type: 'assistant/message', text: 'before' }], 'the baseline is replayed (SPEC 7.2)')

  mesh.emit('node-a', sessionId, { type: 'assistant/message', text: 'live' })
  assert.equal(seen.length, 2)

  off()
  assert.equal(mesh.followerCount('node-a', sessionId), 0)
  mesh.emit('node-a', sessionId, { type: 'assistant/message', text: 'after' })
  assert.equal(seen.length, 2, 'no events are delivered after unsubscribe')
  assert.equal(mesh.sessionEvents('node-a', sessionId).length, 3, 'history keeps recording')

  off()
  assert.equal(mesh.followerCount('node-a', sessionId), 0, 'unsubscribe is idempotent')
})

test('scriptEvents feeds a scripted stream and each follower gets its own subscription', async () => {
  const mesh = seedTransport()
  const sessionId = await mesh.createSession('node-a', 'ws-1')

  mesh.scriptEvents('node-a', sessionId, [
    { type: 'assistant/message', text: 'one' },
    { type: 'assistant/message', text: 'two' },
  ])
  assert.deepEqual(mesh.sessionEvents('node-a', sessionId).length, 2, 'scripted events are recorded before any follower')

  const first: unknown[] = []
  const second: unknown[] = []
  const offFirst = await mesh.follow('node-a', sessionId, (event) => first.push(event))
  const offSecond = await mesh.follow('node-a', sessionId, (event) => second.push(event))
  assert.equal(first.length, 2)
  assert.equal(second.length, 2)

  mesh.emit('node-a', sessionId, { type: 'assistant/message', text: 'three' })
  assert.equal(first.length, 3)
  assert.equal(second.length, 3)

  offFirst()
  mesh.emit('node-a', sessionId, { type: 'assistant/message', text: 'four' })
  assert.equal(first.length, 3, 'only the unsubscribed follower stops')
  assert.equal(second.length, 4)
  offSecond()
})

test('injected faults fail the requested number of calls and then clear', async () => {
  const mesh = seedTransport()
  mesh.failNext('listNodes', { code: 'timeout', message: 'peer timed out', times: 2 })

  await assert.rejects(() => mesh.listNodes(), hasCode('timeout'))
  await assert.rejects(() => mesh.listNodes(), hasCode('timeout'))
  assert.equal((await mesh.listNodes()).length, 2, 'the fault cleared itself after two calls')
  assert.equal(mesh.calls('listNodes').length, 3, 'faulted calls are still logged')
})

test('a seeded fault stays armed until clearFault', async () => {
  const mesh = seedTransport({ faults: { listWorkspaces: { code: 'denied' } } })

  await assert.rejects(() => mesh.listWorkspaces('node-a'), hasCode('denied'))
  await assert.rejects(() => mesh.listWorkspaces('node-a'), hasCode('denied'))
  mesh.clearFault('listWorkspaces')
  assert.equal((await mesh.listWorkspaces('node-a')).length, 1)
})

test('an offline node keeps its metadata but refuses new work', async () => {
  const mesh = seedTransport()
  const sessionId = await mesh.createSession('node-a', 'ws-1')

  mesh.setOnline('node-a', false)
  await assert.rejects(() => mesh.createSession('node-a', 'ws-1'), hasCode('node-offline'))
  await assert.rejects(() => mesh.prompt('node-a', sessionId, 'x'), hasCode('node-offline'))
  await assert.rejects(() => mesh.follow('node-a', sessionId, () => {}), hasCode('node-offline'))
  assert.equal((await mesh.listWorkspaces('node-a')).length, 1, 'the last known manifest stays readable')

  mesh.setOnline('node-a', true)
  await mesh.prompt('node-a', sessionId, 'x')
  assert.deepEqual(mesh.prompts('node-a', sessionId), ['x'])
})

test('the mock transport drives the full dispatch path with scripted replies', async () => {
  const mesh = seedTransport({
    autoRespond: ({ text, index }) => [{ type: 'assistant/message', text: 'ack ' + index + ': ' + text }],
  })

  const node = (await mesh.listNodes()).find((candidate) => candidate.online)!
  const workspace = (await mesh.listWorkspaces(node.nodeId))[0]!
  const sessionId = await mesh.createSession(node.nodeId, workspace.workspaceId)

  const events: unknown[] = []
  const off = await mesh.follow(node.nodeId, sessionId, (event) => events.push(event))
  await mesh.prompt(node.nodeId, sessionId, 'build it')
  off()

  assert.deepEqual(events, [{ type: 'assistant/message', text: 'ack 0: build it' }])
  assert.deepEqual(
    mesh.calls().map((call) => call.method),
    ['listNodes', 'listWorkspaces', 'createSession', 'follow', 'prompt'],
  )
})

test('all five methods work with network access disabled', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (() => {
    attempts += 1
    throw new Error('network access attempted')
  }) as typeof fetch
  try {
    const mesh = seedTransport()
    assert.equal((await mesh.listNodes()).length, 2)
    assert.equal((await mesh.listWorkspaces('node-a')).length, 1)
    const sessionId = await mesh.createSession('node-a', 'ws-1')
    const seen: unknown[] = []
    const off = await mesh.follow('node-a', sessionId, (event) => seen.push(event))
    await mesh.prompt('node-a', sessionId, 'no-network')
    off()
    assert.equal(attempts, 0, 'the mock transport never touches the network')
    assert.deepEqual(seen, [], 'no autoRespond configured, so nothing is emitted')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the mock transport module has zero package imports and spawns nothing', () => {
  const source = readFileSync(new URL('../../src/transport/mock.ts', import.meta.url), 'utf8')
  const specifiers = [...new Set([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!))].sort()
  assert.deepEqual(specifiers, ['../types.js', './types.js'], 'only the local type modules are imported')
  for (const token of ['node:http', 'node:https', 'node:net', 'node:child_process', 'spawn(', 'exec(', 'fetch(', 'setTimeout']) {
    assert.equal(source.includes(token), false, 'mock.ts must not reference ' + token)
  }
})
