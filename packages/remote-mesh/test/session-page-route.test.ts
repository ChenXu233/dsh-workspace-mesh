import assert from 'node:assert/strict'
import test from 'node:test'

import {
  handleSessionEvents,
  handleSessionLive,
  handleSessionOpen,
  handleSessionPrompt,
  MESH_SESSION_EVENTS_PATH,
  MESH_SESSION_LIVE_PATH,
  MESH_SESSION_OPEN_PATH,
  MESH_SESSION_PROMPT_PATH,
  registerMeshSessionPageRoutes,
} from '../src/api/session.js'
import { AssistantLiveHub } from '../src/live/assistant.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/index.js'
import type { MeshEventPage, MeshTransport } from '../src/transport/types.js'

/** The conversation page reads the peer's own log and drives the Session there. */

interface Recorded {
  events: Array<{ nodeId: string; sessionId: string; request: unknown }>
  opened: Array<{ nodeId: string; workspaceId: string }>
  prompts: Array<{ nodeId: string; sessionId: string; text: string }>
}

function transportOf(recorded: Recorded, withEvents = true): MeshTransport {
  return {
    kind: 'mock',
    listNodes: async () => [],
    listWorkspaces: async () => [],
    createSession: async (nodeId, workspaceId) => {
      recorded.opened.push({ nodeId, workspaceId })
      return 'session-new'
    },
    prompt: async (nodeId, sessionId, text) => {
      recorded.prompts.push({ nodeId, sessionId, text })
    },
    follow: async () => () => {},
    ...(withEvents
      ? {
        readEvents: async (nodeId: string, sessionId: string, request?: unknown): Promise<MeshEventPage> => {
          recorded.events.push({ nodeId, sessionId, request })
          return {
            events: [
              { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
              { seq: 2, type: 'assistant/message', data: { message: { content: [] } } },
            ],
            hasMore: true,
            endSeq: 2,
            running: false,
          }
        },
      }
      : {}),
  }
}

function runtime(transport: MeshTransport): MeshToolRuntime {
  const config: MeshToolConfig = { transportMode: 'auto', leaseMs: 900_000, dispatchTimeoutMs: 5_000, leaseOwner: 'lead' }
  return {
    board: createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    transport,
    config,
    now: () => 1_000,
  }
}

function get(path: string, query: string): Request {
  return new Request('http://dsh.internal' + path + query, { method: 'GET' })
}

function post(path: string, body: unknown): Request {
  return new Request('http://dsh.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET /api/mesh/session/events hands over the raw log window', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionEvents(get(MESH_SESSION_EVENTS_PATH, '?nodeId=peer-a&sessionId=session-1&maxMessages=50'), {
    runtime: runtime(transportOf(recorded)),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.deepEqual(body.events.map((event: any) => event.seq), [1, 2])
  assert.equal(body.hasMore, true)
  assert.equal(body.endSeq, 2)
  assert.equal(body.running, false)
  assert.deepEqual(recorded.events[0]?.request, { maxMessages: 50 })
})

test('session/events requires both ids and refuses a transport without the capability', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const missing = await handleSessionEvents(get(MESH_SESSION_EVENTS_PATH, '?nodeId=peer-a'), { runtime: runtime(transportOf(recorded)) })
  assert.equal(missing.status, 400)
  const unsupported = await handleSessionEvents(get(MESH_SESSION_EVENTS_PATH, '?nodeId=peer-a&sessionId=s1'), {
    runtime: runtime(transportOf(recorded, false)),
  })
  const body = (await unsupported.json()) as Record<string, any>
  assert.equal(body.ok, false)
  assert.equal(body.code, 'unavailable')
})

test('POST /api/mesh/session/open creates the Session on the owning machine', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionOpen(post(MESH_SESSION_OPEN_PATH, { nodeId: 'peer-a', workspaceId: 'ws-1' }), {
    runtime: runtime(transportOf(recorded)),
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-new')
  assert.deepEqual(recorded.opened, [{ nodeId: 'peer-a', workspaceId: 'ws-1' }])
})

test('session/open refuses a body without both ids', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionOpen(post(MESH_SESSION_OPEN_PATH, { nodeId: 'peer-a' }), {
    runtime: runtime(transportOf(recorded)),
  })
  assert.equal(response.status, 400)
})

test('POST /api/mesh/session/prompt forwards the message to the owning machine', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionPrompt(post(MESH_SESSION_PROMPT_PATH, {
    nodeId: 'peer-a',
    sessionId: 'session-1',
    text: 'hello there',
  }), { runtime: runtime(transportOf(recorded)) })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.deepEqual(recorded.prompts, [{ nodeId: 'peer-a', sessionId: 'session-1', text: 'hello there' }])
})

test('session/prompt refuses empty text', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionPrompt(post(MESH_SESSION_PROMPT_PATH, {
    nodeId: 'peer-a',
    sessionId: 'session-1',
    text: '   ',
  }), { runtime: runtime(transportOf(recorded)) })
  assert.equal(response.status, 400)
  assert.deepEqual(recorded.prompts, [])
})

test('the three page routes mount on one context with their own methods', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  registerMeshSessionPageRoutes(ctx as never, runtime(transportOf({ events: [], opened: [], prompts: [] })))
  assert.deepEqual(routes.map(route => [route.path, route.methods]), [
    [MESH_SESSION_EVENTS_PATH, ['GET']],
    [MESH_SESSION_LIVE_PATH, ['GET']],
    [MESH_SESSION_OPEN_PATH, ['POST']],
    [MESH_SESSION_PROMPT_PATH, ['POST']],
  ])
})

function hubWithFrames(): AssistantLiveHub {
  // A context without an event bus keeps the Hub inert; frames are fed by hand,
  // which is exactly the wire shape a reading browser sees.
  const hub = new AssistantLiveHub({} as never)
  ;(hub as unknown as { accept(payload: unknown): void }).accept({
    agent: { session: { id: 'session-1', seq: 7 } },
    frame: { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 },
  })
  ;(hub as unknown as { accept(payload: unknown): void }).accept({
    agent: { session: { id: 'session-1', seq: 7 } },
    frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, time: 5, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
  })
  return hub
}

test('GET /api/mesh/session/live answers from this Host\'s retained frames', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const hub = hubWithFrames()
  const response = await handleSessionLive(get(MESH_SESSION_LIVE_PATH, '?sessionId=session-1&since=0'), {
    runtime: runtime(transportOf(recorded)),
    hub,
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.revision, 2)
  assert.deepEqual(body.frames.map((frame: any) => frame.type), ['start', 'chunk'])
  assert.equal(body.frames[0].startedAfterSeq, 6)
})

test('live frames newer than the cursor only, and an unknown Session is empty', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const hub = hubWithFrames()
  const control = { runtime: runtime(transportOf(recorded)), hub }
  const later = await handleSessionLive(get(MESH_SESSION_LIVE_PATH, '?sessionId=session-1&since=2'), control)
  const laterBody = (await later.json()) as Record<string, any>
  assert.deepEqual(laterBody.frames, [])
  assert.equal(laterBody.revision, 2)
  const unknown = await handleSessionLive(get(MESH_SESSION_LIVE_PATH, '?sessionId=other'), control)
  const unknownBody = (await unknown.json()) as Record<string, any>
  assert.equal(unknownBody.ok, true)
  assert.deepEqual(unknownBody.frames, [])
})

test('a page forwards the live read to the machine that runs the Session', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const transport = transportOf(recorded)
  let asked: { nodeId: string, sessionId: string, since: number } | undefined
  const forwarding = {
    ...transport,
    readAssistantLive: async (nodeId: string, sessionId: string, since: number) => {
      asked = { nodeId, sessionId, since }
      return { revision: 9, frames: [] }
    },
  }
  const response = await handleSessionLive(get(MESH_SESSION_LIVE_PATH, '?nodeId=peer-a&sessionId=session-1&since=4'), {
    runtime: runtime(forwarding),
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.revision, 9)
  assert.deepEqual(asked, { nodeId: 'peer-a', sessionId: 'session-1', since: 4 })
})

test('a transport without live support says so instead of answering empty', async () => {
  const recorded: Recorded = { events: [], opened: [], prompts: [] }
  const response = await handleSessionLive(get(MESH_SESSION_LIVE_PATH, '?nodeId=peer-a&sessionId=session-1'), {
    runtime: runtime(transportOf(recorded, false)),
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, false)
  assert.equal(body.code, 'unavailable')
})
