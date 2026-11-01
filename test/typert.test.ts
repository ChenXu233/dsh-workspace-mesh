import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTypertTransport, TypertRpcError } from '../src/transport/typert.js'

/**
 * The peer is a DSH web host. These tests stand in for it with a fake fetch that
 * speaks the measured wire shapes (evidence/s0-typert-cross-machine.md §2), so
 * the adapter is covered without a network or a second machine.
 */

interface RpcCall { method: string; args: Record<string, unknown> }

interface FakePeerOptions {
  sessions?: Array<Record<string, unknown>>
  events?: Record<number, Array<{ type: string; seq: number; data?: unknown }>>
  /** Cursor reported by session/list, advanced by the test. */
  cursor?: number
  token?: string
  rejectFirst?: boolean
}

function fakePeer(options: FakePeerOptions = {}) {
  const calls: RpcCall[] = []
  let cursor = options.cursor ?? 0
  let issuedCookie = false
  let rejected = false
  const token = options.token ?? 'tok'
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/connect')) {
      const parsed = new URL(url)
      if (parsed.searchParams.get('token') !== token) {
        return new Response('', { status: 401 })
      }
      issuedCookie = true
      const headers = new Headers()
      headers.append('set-cookie', 'dsh-auth-abc=1; Path=/; HttpOnly')
      return new Response(null, { status: 302, headers })
    }
    const method = url.split('/api/')[1] ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: { args?: Record<string, unknown> } }
    const args = body.payload?.args ?? {}
    calls.push({ method, args })
    const cookie = String((init?.headers as Record<string, string> | undefined)?.cookie ?? '')
    if (!issuedCookie || !cookie.includes('dsh-auth')) return new Response('', { status: 401 })
    if (options.rejectFirst === true && !rejected) {
      rejected = true
      return new Response('', { status: 401 })
    }
    const reply = (result: unknown): Response =>
      new Response(JSON.stringify({ type: 'server-response', rpcId: 'x', result }), { status: 200 })

    if (method === 'session/list') {
      return reply({ ok: true, value: { items: (options.sessions ?? []).map((row) => ({ ...row, projections: { asOfSeq: cursor, values: {} } })) } })
    }
    if (method === 'session/create') {
      return reply({ ok: true, value: { sessionId: 'session-new' } })
    }
    if (method === 'session/prompt') {
      return reply({ ok: true, value: { accepted: true } })
    }
    if (method === 'session/page') {
      const request = (args.request ?? {}) as { throughSeq?: number }
      const through = request.throughSeq ?? 0
      const records = (options.events?.[through] ?? []).map((event) => ({ type: 'event', event }))
      return reply({ ok: true, value: { records, hasMore: false } })
    }
    return reply({ ok: false, error: { code: 'gateway/not-found', message: 'no such method' } })
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    calls,
    advanceTo(next: number) { cursor = next },
  }
}

const peers = [{ nodeId: 'peer-a', baseUrl: 'https://peer.example.com', token: 'tok' }]

test('listNodes reports the peer online and projects its assigned workspaces', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }] })
  const transport = createTypertTransport({
    peers,
    fetchImpl: peer.fetchImpl,
    listAssigned: () => [{ workspaceId: 'ws-a', cwd: '/data/ws-a' }],
    now: () => 42,
  })
  const nodes = await transport.listNodes()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]?.nodeId, 'peer-a')
  assert.equal(nodes[0]?.online, true)
  assert.equal(nodes[0]?.lastSeenAt, 42)
  assert.deepEqual(nodes[0]?.workspaces.map((w) => [w.workspaceId, w.path]), [['ws-a', '/data/ws-a']])
})

test('listNodes marks the peer offline when the call fails, instead of throwing', async () => {
  const transport = createTypertTransport({
    peers: [{ nodeId: 'peer-a', baseUrl: 'https://peer.example.com', token: 'stale' }],
    fetchImpl: fakePeer({ token: 'tok' }).fetchImpl,
  })
  const nodes = await transport.listNodes()
  assert.equal(nodes[0]?.online, false)
})

test('createSession sends the assignment cwd and rejects an unassigned workspace', async () => {
  const peer = fakePeer()
  const transport = createTypertTransport({
    peers,
    fetchImpl: peer.fetchImpl,
    resolveWorkspace: (id) => (id === 'ws-a' ? { nodeId: 'peer-a', cwd: '/data/ws-a' } : undefined),
  })
  assert.equal(await transport.createSession('peer-a', 'ws-a'), 'session-new')
  const create = peer.calls.find((call) => call.method === 'session/create')
  assert.deepEqual(create?.args, { request: { cwd: '/data/ws-a' } })

  await assert.rejects(() => transport.createSession('peer-a', 'ws-missing'), (err: unknown) => {
    assert.ok(err instanceof TypertRpcError)
    assert.equal(err.code, 'unknown-workspace')
    return true
  })
})

test('prompt sends one queued text part with a client-minted requestId', async () => {
  const peer = fakePeer()
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  await transport.prompt('peer-a', 'session-1', 'do the thing')
  const call = peer.calls.find((entry) => entry.method === 'session/prompt')
  const request = (call?.args.request ?? {}) as Record<string, unknown>
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.mode, 'queue')
  assert.equal(typeof request.requestId, 'string')
  assert.deepEqual(request.content, [{ type: 'text', text: 'do the thing' }])
})

test('follow delivers history as a baseline, then only new events after the boundary', async () => {
  const peer = fakePeer({
    sessions: [{ sessionId: 'session-1' }],
    cursor: 3,
    events: {
      3: [
        { type: 'user/message', seq: 1 },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'old' }] } } },
        { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
      ],
      6: [
        { type: 'user/message', seq: 4 },
        { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'new' }] } } },
        { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
      ],
    },
  })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, pollMs: 5 })
  const seen: Array<{ type?: string; seq?: number }> = []
  const stop = await transport.follow('peer-a', 'session-1', (event) => seen.push(event as { type?: string; seq?: number }))

  assert.deepEqual(seen.map((event) => event.seq), [1, 2, 3, 3])
  assert.equal(seen.at(-1)?.type, 'mesh/baseline/end')

  peer.advanceTo(6)
  await new Promise((resolve) => setTimeout(resolve, 40))
  stop()

  const live = seen.slice(4)
  assert.deepEqual(live.map((event) => event.seq), [4, 5, 6])
  const countAfterStop = seen.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(seen.length, countAfterStop, 'no events after unsubscribe')
})

test('a stale cookie is refreshed once instead of surfacing as a failure', async () => {
  const peer = fakePeer({ rejectFirst: true })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  await transport.prompt('peer-a', 'session-1', 'hello')
  const prompts = peer.calls.filter((call) => call.method === 'session/prompt')
  assert.equal(prompts.length, 2, 'retried after the 401')
})

test('a rejected envelope surfaces the mapped error code', async () => {
  const transport = createTypertTransport({
    peers,
    fetchImpl: fakePeer({ sessions: [{ sessionId: 's1' }] }).fetchImpl,
  })
  await assert.rejects(() => transport.follow('peer-a', 'session-missing', () => {}), (err: unknown) => {
    assert.ok(err instanceof TypertRpcError)
    assert.equal(err.code, 'unknown-session')
    return true
  })
})

test('an unknown node is refused before any network call', async () => {
  const peer = fakePeer()
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  await assert.rejects(() => transport.listWorkspaces('nobody'), (err: unknown) => {
    assert.ok(err instanceof TypertRpcError)
    assert.equal(err.code, 'unknown-node')
    return true
  })
  assert.equal(peer.calls.length, 0)
})
