/**
 * The remote conversation page's data: one peer Session's event log, pulled
 * live and assembled by the shipped Chat renderer.
 *
 * A page is a *view* of a Session that lives on the other machine: the peer's
 * own agent loop runs there, its own log records the events, and this module
 * only moves those events across and hands them to the official assembler. No
 * lifecycle of our own — the transcript is whatever the log currently says.
 *
 * Opening a Session is deferred to the first message: browsing remote
 * workspaces must not create Sessions on the peer.
 */
import { useSyncExternalStore } from 'react'
import { currentDispatchTarget } from './dispatch-target'
import type { DispatchTarget } from './dispatch-target'

/** One durable event, as the peer's log records it (already lossless JSON). */
export interface RemoteEvent {
  readonly seq: number
  readonly type?: string
  readonly time?: number
  readonly data?: unknown
  readonly [key: string]: unknown
}

/** Where the page currently is. */
export type RemotePhase = 'idle' | 'opening' | 'live' | 'error'

/** What the page renders from. */
export interface RemotePageState {
  readonly target: DispatchTarget | undefined
  readonly sessionId: string | undefined
  readonly phase: RemotePhase
  readonly error: string | undefined
  /** Durable events, ascending by seq. */
  readonly events: readonly RemoteEvent[]
  /** Whether older events exist before the loaded window. */
  readonly hasMore: boolean
  /** Whether the peer's Session is running right now. */
  readonly running: boolean
  /** Bumped whenever the event window actually changed. */
  readonly revision: number
}

const IDLE: RemotePageState = {
  target: undefined,
  sessionId: undefined,
  phase: 'idle',
  error: undefined,
  events: [],
  hasMore: false,
  running: false,
  revision: 0,
}

let state: RemotePageState = IDLE
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

function publish(next: RemotePageState): void {
  state = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[remote-mesh] page subscriber failed:', error)
    }
  }
}

function sameTarget(left: DispatchTarget | undefined, right: DispatchTarget | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.nodeId === right.nodeId && left.workspaceId === right.workspaceId
}

/** Read the page state; stable identity until something changed. */
export function remotePageState(): RemotePageState {
  return state
}

/**
 * Subscribe to page changes.
 * @param listener - change callback.
 * @returns unsubscribe.
 */
export function subscribeRemotePage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** JSON POST helper that never throws on a business refusal. */
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  return payload ?? { ok: false, error: `HTTP ${String(response.status)}` }
}

function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

/** Open the peer Session for the current target (idempotent). */
async function ensureSession(target: DispatchTarget): Promise<string | undefined> {
  if (state.sessionId !== undefined) return state.sessionId
  publish({ ...state, phase: 'opening', error: undefined })
  try {
    const payload = await post('/api/mesh/session/open', {
      nodeId: target.nodeId,
      workspaceId: target.workspaceId,
    })
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (payload.ok !== true || sessionId === '') {
      publish({ ...state, phase: 'error', error: String(payload.error ?? 'open failed') })
      return undefined
    }
    publish({ ...state, sessionId, phase: 'live', error: undefined })
    return sessionId
  } catch (error) {
    publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** Pull the current tail of the peer's log into the page. */
async function poll(): Promise<void> {
  if (inflight) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const { target, sessionId } = state
  if (target === undefined || sessionId === undefined) return
  inflight = true
  try {
    const url = new URL('/api/mesh/session/events', globalThis.location.origin)
    url.searchParams.set('nodeId', target.nodeId)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('maxMessages', '200')
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (payload === undefined) return
    if (payload.ok !== true) {
      const message = typeof payload.error === 'string' ? payload.error : 'session read failed'
      // A peer that is down reports here; the page keeps its last window.
      if (state.phase !== 'error') publish({ ...state, phase: 'error', error: message })
      return
    }
    const incoming = Array.isArray(payload.events) ? payload.events as RemoteEvent[] : []
    const events = mergeEvents(state.events, incoming)
    const running = payload.running === true
    const hasMore = payload.hasMore === true
    const changed = events !== state.events || running !== state.running || hasMore !== state.hasMore
    publish({
      ...state,
      phase: 'live',
      error: undefined,
      events,
      hasMore,
      running,
      revision: changed ? state.revision + 1 : state.revision,
    })
  } catch (error) {
    if (state.phase !== 'error') {
      publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  } finally {
    inflight = false
  }
}

/**
 * Merge one freshly read window into the loaded one.
 *
 * The peer pages backwards from its own head, so a poll can return a window
 * that moved: the union keyed by seq keeps earlier events and appends while the
 * log grows. Identical windows keep their array identity, which is what stops
 * the assembler from rebuilding on every tick.
 * @param previous - events already on the page.
 * @param incoming - events just read.
 * @returns the merged list, or the previous identity when nothing changed.
 */
function mergeEvents(previous: readonly RemoteEvent[], incoming: readonly RemoteEvent[]): readonly RemoteEvent[] {
  if (incoming.length === 0) return previous
  const bySeq = new Map<number, RemoteEvent>()
  for (const event of previous) bySeq.set(event.seq, event)
  const before = bySeq.size
  for (const event of incoming) bySeq.set(event.seq, event)
  const grew = bySeq.size !== before
  const tailChanged = previous.length === 0
    || incoming[incoming.length - 1]?.seq !== previous[previous.length - 1]?.seq
  if (!grew && !tailChanged) return previous
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** Start (or keep) the page for one target. */
function begin(target: DispatchTarget): void {
  if (sameTarget(state.target, target)) {
    if (timer === undefined && state.phase !== 'error') startPolling()
    return
  }
  stopTimer()
  publish({ ...IDLE, target, revision: state.revision + 1 })
  startPolling()
}

function startPolling(): void {
  if (timer !== undefined) return
  timer = setInterval(() => { void poll() }, 900)
}

/** Leave the page and forget the peer Session. */
function end(): void {
  stopTimer()
  if (state === IDLE) return
  publish({ ...IDLE, revision: state.revision + 1 })
}

/**
 * Follow the dispatch target: the page exists exactly while one is set.
 * @param target - the current target, or undefined for this machine.
 */
export function syncRemoteSession(target: DispatchTarget | undefined): void {
  if (target === undefined) end()
  else begin(target)
}

/**
 * Send one message into the page's peer Session.
 *
 * The Session is opened on the first message, then reused: the page is one
 * conversation, not one task per keystroke.
 * @param text - the message body.
 * @returns completion of the prompt (the peer's reply arrives through polling).
 */
export async function sendRemoteMessage(text: string): Promise<void> {
  const target = currentDispatchTarget()
  if (target === undefined) return
  const body = text.trim()
  if (body === '') return
  if (!sameTarget(state.target, target)) begin(target)
  const sessionId = await ensureSession(target)
  if (sessionId === undefined) return
  try {
    const payload = await post('/api/mesh/session/prompt', {
      nodeId: target.nodeId,
      sessionId,
      text: body,
    })
    if (payload.ok !== true) {
      publish({
        ...state,
        phase: 'error',
        error: typeof payload.error === 'string' ? payload.error : 'prompt failed',
      })
      return
    }
    // Show the user's own row without waiting a full poll interval.
    void poll()
    startPolling()
  } catch (error) {
    publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
  }
}

/** Read the page state as React state. */
export function useRemotePageState(): RemotePageState {
  return useSyncExternalStore(subscribeRemotePage, remotePageState, remotePageState)
}
