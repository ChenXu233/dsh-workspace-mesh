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
  /** Secret the peer requires on /api/mesh/handshake; enables relay mode. */
  meshSecret?: string
  /** Relay reads that die on the socket before answering, then succeed. */
  relayListResets?: number
  /** Relay prompts that die on the socket before answering (must never be replayed). */
  relayPromptResets?: number
  /** Token-mode session/list calls that answer 502, then succeed. */
  listBadGateway?: number
  /** session/page answers the host's "session/not-found" envelope. */
  pageNotFound?: boolean
}

function fakePeer(options: FakePeerOptions = {}) {
  const calls: RpcCall[] = []
  let cursor = options.cursor ?? 0
  let issuedCookie = false
  let rejected = false
  let connectAttempts = 0
  let relayListResets = options.relayListResets ?? 0
  let relayPromptResets = options.relayPromptResets ?? 0
  let listBadGateway = options.listBadGateway ?? 0
  const relayOps: string[] = []
  const token = options.token ?? 'tok'
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/connect')) {
      connectAttempts += 1
      const parsed = new URL(url)
      if (parsed.searchParams.get('token') !== token) {
        return new Response('', { status: 401 })
      }
      issuedCookie = true
      const headers = new Headers()
      headers.append('set-cookie', 'dsh-auth-abc=1; Path=/; HttpOnly')
      return new Response(null, { status: 302, headers })
    }
    if (url.endsWith('/api/mesh/handshake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { hmac?: string }
      if (options.meshSecret === undefined || body.hmac === undefined) return new Response('', { status: 401 })
      return new Response(JSON.stringify({ ok: true, token: 'mesh-token', expiresAt: Date.now() + 600_000 }), { status: 200 })
    }
    if (url.endsWith('/api/mesh/relay')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { token?: string; op?: string; args?: Record<string, unknown> }
      if (body.token !== 'mesh-token') return new Response('', { status: 401 })
      relayOps.push(String(body.op))
      if (body.op === 'list' && relayListResets > 0) {
        relayListResets -= 1
        throw new TypeError('fetch failed')
      }
      if (body.op === 'prompt') {
        if (relayPromptResets > 0) {
          relayPromptResets -= 1
          throw new TypeError('fetch failed')
        }
        return new Response(JSON.stringify({ ok: true, value: { accepted: true } }), { status: 200 })
      }
      if (body.op === 'workspaces') {
        return new Response(JSON.stringify({ ok: true, value: { workspaces: options.nativeWorkspaces ?? [] } }), { status: 200 })
      }
      if (body.op === 'list') {
        return new Response(JSON.stringify({ ok: true, value: { items: options.sessions ?? [] } }), { status: 200 })
      }
      if (body.op === 'create') return new Response(JSON.stringify({ ok: true, value: { sessionId: 'session-relay' } }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'unsupported op' }), { status: 200 })
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
    if (method === 'session/list' && listBadGateway > 0) {
      listBadGateway -= 1
      return new Response('', { status: 502 })
    }
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
      if (options.pageNotFound === true) {
        return reply({ ok: false, error: { code: 'session/not-found', message: 'session "s1" not found' } })
      }
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
    relayOps,
    connectAttempts: () => connectAttempts,
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

/**
 * A refresh fans out over the network, so the number of round trips is part of
 * the contract: the registry read already proves the peer answers, and probing
 * with a second listSessions() made every refresh cost three calls, two of them
 * the whole session list.
 */
test('one refresh asks each peer once, not three times', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog' }] })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  await transport.listNodes()
  assert.equal(peer.calls.filter((call) => call.method === 'session/list').length, 1)
})

test('a relay refresh is one registry read plus one session list', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], meshSecret: 'shared' })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, meshSecret: 'shared' })
  await transport.listNodes()
  assert.deepEqual([...peer.relayOps].sort(), ['list', 'workspaces'])
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

test('relay mode works with a stale login token: the handshake replaces it', async () => {
  const peer = fakePeer({
    sessions: [{ sessionId: 's1', updatedAt: 5, projections: { values: { title: 'Blog' } } }],
    nativeWorkspaces: [{ workspaceId: 'workspace-abc', title: 'Blog', path: '/data/blog', sessionIds: ['s1'] }],
    meshSecret: 'shared',
  })
  const transport = createTypertTransport({
    peers: [{ nodeId: 'peer-a', baseUrl: 'https://peer.example.com', token: 'STALE-TOKEN' }],
    fetchImpl: peer.fetchImpl,
    meshSecret: 'shared',
  })
  const workspaces = await transport.listWorkspaces('peer-a')
  assert.deepEqual(workspaces.map((w) => [w.workspaceId, w.name]), [['workspace-abc', 'Blog']])
  assert.equal(peer.connectAttempts(), 0, 'relay mode never touches the login surface')
  assert.equal(await transport.createSession('peer-a', 'workspace-abc'), 'session-relay')
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

test('repeated failures back off further instead of retrying at a fixed rate', async () => {
  let clock = 1_000
  const peer = fakePeer({ token: 'other' })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, failureCooldownMs: 60_000, now: () => clock })
  await transport.listNodes() // failure 1
  await transport.listNodes() // failure 2 -> 60s cooldown
  const afterTwo = peer.connectAttempts()
  clock += 61_000
  await transport.listNodes() // failure 3 -> 120s cooldown
  assert.ok(peer.connectAttempts() > afterTwo, 'retried once the cooldown expired')
  const afterThree = peer.connectAttempts()
  clock += 61_000 // still inside the doubled window
  await transport.listNodes()
  assert.equal(peer.connectAttempts(), afterThree, 'the second cooldown is longer than the first')
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

/**
 * A busy peer answers `session/list` in seconds, and a keep-alive socket that
 * closes under a slow request surfaces as ECONNRESET — measured on the two cloud
 * hosts, not a hypothetical. Reads are replayed; writes are not.
 */

test('a relay read that loses its connection is replayed once', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], meshSecret: 'shared', relayListResets: 1 })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, meshSecret: 'shared' })
  const messages = await transport.readSession?.('peer-a', 's1')
  assert.deepEqual(messages, [])
  assert.equal(peer.relayOps.filter((op) => op === 'list').length, 2, 'the read ran twice')
})

test('a relay prompt is never replayed: a lost connection is not a second turn', async () => {
  const peer = fakePeer({ meshSecret: 'shared', relayPromptResets: 1 })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl, meshSecret: 'shared' })
  await assert.rejects(() => transport.prompt('peer-a', 's1', 'hi'), (err: unknown) => {
    assert.ok(err instanceof TypertRpcError)
    assert.equal(err.code, 'remote-failure')
    return true
  })
  assert.equal(peer.relayOps.filter((op) => op === 'prompt').length, 1, 'one attempt, one turn')
})

test('a token-mode read survives one bad gateway', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], listBadGateway: 1 })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  const messages = await transport.readSession?.('peer-a', 's1')
  assert.deepEqual(messages, [])
  assert.equal(peer.calls.filter((call) => call.method === 'session/list').length, 2)
})

test('a peer not-found code surfaces as unknown-session, not remote-failure', async () => {
  const peer = fakePeer({ sessions: [{ sessionId: 's1' }], cursor: 5, pageNotFound: true })
  const transport = createTypertTransport({ peers, fetchImpl: peer.fetchImpl })
  const readSession = transport.readSession
  assert.ok(readSession !== undefined)
  await assert.rejects(() => readSession('peer-a', 's1'), (err: unknown) => {
    assert.ok(err instanceof TypertRpcError)
    assert.equal(err.code, 'unknown-session')
    return true
  })
})

