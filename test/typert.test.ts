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
  nativeWorkspaces?: Array<{ workspaceId: string; title?: string; path?: string; sessionIds?: string[] }>
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
    if (url.endsWith('/api/mesh/workspaces')) {
      const cookieHeader = String((init?.headers as Record<string, string> | undefined)?.cookie ?? '')
      if (!issuedCookie || !cookieHeader.includes('dsh-auth')) return new Response('', { status: 401 })
      return new Response(JSON.stringify({ ok: true, workspaces: options.nativeWorkspaces ?? [] }), { status: 200 })
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
      return reply({ ok: true, value: { items: (options.sessions ?? []).map((row) => {
        const projections = (row.projections ?? {}) as Record<string, unknown>
        return { ...row, projections: { ...projections, asOfSeq: cursor, values: projections.values ?? {} } }
      }) } })
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

test('listNodes reports the peer online and projects its native workspaces', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog' }] })
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
  // Session s1 has no cwd, so it also shows up as its own ungrouped bucket; the
  // native workspace must stay first.
  assert.deepEqual(nodes[0]?.workspaces[0] && [nodes[0].workspaces[0].workspaceId, nodes[0].workspaces[0].path], ['workspace-abc', '/data/blog'])
})

test('listNodes falls back to assignment aliases when the peer cannot report its registry', async () => {
  // No nativeWorkspaces: the fake answers the route with an empty list, which is
  // still a successful answer — so use a peer that rejects the route instead.
  const transport = createTypertTransport({
    peers: [{ nodeId: 'peer-a', baseUrl: 'https://peer.example.com', token: 'tok' }],
    fetchImpl: fakePeer({ sessions: [{ sessionId: 's1' }], nativeWorkspaces: undefined }).fetchImpl,
    listAssigned: () => [{ workspaceId: 'ws-a', cwd: '/data/ws-a' }],
    workspacesPath: '/api/mesh/nonexistent',
  })
  const nodes = await transport.listNodes()
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

test('listWorkspaces prefers the peer native registry over assignment aliases', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog' }] })
  const transport = createTypertTransport({
    peers,
    fetchImpl: peer.fetchImpl,
    listAssigned: () => [{ workspaceId: 'ws-blog', cwd: '/data/workspace' }],
  })
  const workspaces = await transport.listWorkspaces('peer-a')
  assert.deepEqual(workspaces[0] && [workspaces[0].workspaceId, workspaces[0].name, workspaces[0].path], ['workspace-abc', 'Blog', '/data/blog'])
})

test('a workspace carries its sessions, joined from the peer session log', async () => {
  const peer = fakePeer({
    sessions: [
      { sessionId: 's1', updatedAt: 11, running: false, projections: { values: { title: 'Blog rewrite' } } },
      { sessionId: 's2', updatedAt: 22, running: true, projections: { values: { title: 'Deploy' } } },
    ],
    nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog', sessionIds: ['s1', 's2'] }],
  })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  const workspaces = await transport.listWorkspaces('peer-a')
  // Newest first: a workspace lists its conversations the way a sidebar does.
  assert.deepEqual(workspaces[0]?.sessions, [
    { sessionId: 's2', title: 'Deploy', updatedAt: 22, busy: true },
    { sessionId: 's1', title: 'Blog rewrite', updatedAt: 11, busy: false },
  ])
})

test('createSession targets the peer native workspace id, not a cwd alias', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog' }] })
  const transport = createTypertTransport({
    peers,
    fetchImpl: peer.fetchImpl,
    resolveWorkspace: () => ({ nodeId: 'peer-a', cwd: '/data/workspace' }),
  })
  assert.equal(await transport.createSession('peer-a', 'workspace-abc'), 'session-new')
  const create = peer.calls.find((call) => call.method === 'session/create')
  assert.deepEqual(create?.args, { request: { workspaceId: 'workspace-abc' } })
})

test('readSession projects the peer log into user and assistant lines', async () => {
  const peer = fakePeer({
    sessions: [{ sessionId: 'session-1' }],
    cursor: 5,
    events: {
      5: [
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }] } },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
        { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
      ],
    },
  })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  const messages = await transport.readSession?.('peer-a', 'session-1', 10)
  assert.deepEqual(messages?.map((message) => [message.role, message.text]), [['user', 'hello'], ['assistant', 'hi']])
})

test('a failing peer is left alone for the cooldown instead of being hammered', async () => {
  const peer = fakePeer({ token: 'other' }) // every /connect answers 401
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, failureCooldownMs: 60_000, now: () => 1_000 })
  // One failure may be a stale cookie (the client retries once); two in a row
  // mean the peer is unusable, and from then on it is left alone.
  assert.equal((await transport.listNodes())[0]?.online, false)
  assert.equal((await transport.listNodes())[0]?.online, false)
  const callsAfterCooldown = peer.calls.length
  assert.equal((await transport.listNodes())[0]?.online, false)
  assert.equal(peer.calls.length, callsAfterCooldown, 'no extra network calls while cooling down')
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
