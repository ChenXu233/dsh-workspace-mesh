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
import { currentDispatchTarget, setDispatchTarget } from './dispatch-target'
import { refreshRemoteWorkspaces } from './remote-workspaces'
import type { DispatchTarget } from './dispatch-target'
import { dropEntries, EMPTY_LIVE, foldFrames } from './remote-live'
import { openLiveStream } from './remote-live-stream'
import type { LivePage, LiveStreamHandle } from './remote-live-stream'
import type { LiveEntry, LiveState } from './remote-live'

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
  /**
   * Rows folded from the peer's live frames: the answer being written. They are
   * client-only, exactly like the owning browser's, and disappear when the
   * durable message settles the turn.
   */
  readonly live: readonly LiveEntry[]
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
  live: [],
  revision: 0,
}

let state: RemotePageState = IDLE
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let inflight = false
/** Live frames arrive far more often than durable events, so they get their own clock. */
let liveTimer: ReturnType<typeof setInterval> | undefined
let liveInflight = false
/** Consecutive polls with nothing new; a quiet turn stops the timer. */
let liveIdle = 0
let liveState: LiveState = EMPTY_LIVE

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

/** The push stream, when the peer and this Host can hold one open. */
let liveStream: LiveStreamHandle | undefined
/** Bumped on every open so late callbacks from a closed stream are ignored. */
let liveGeneration = 0
/** True while the page wants live rows at all. */
let liveWanted = false
/** Delay before the page stops watching, so the last frames of a turn land. */
let liveStopTimer: ReturnType<typeof setTimeout> | undefined
/** Failed stream opens before falling back to polling. */
let liveRetries = 0

/** Fast clock while the peer is writing: the answer is painted from these frames. */
function startLivePolling(): void {
  if (liveTimer !== undefined || state.sessionId === undefined) return
  liveIdle = 0
  liveTimer = setInterval(() => { void pollLive() }, 150)
  void pollLive()
}

function stopLivePolling(): void {
  if (liveTimer !== undefined) clearInterval(liveTimer)
  liveTimer = undefined
  liveIdle = 0
}

/** Start watching: push first, polling only if the stream cannot be opened. */
function startLive(): void {
  if (state.sessionId === undefined) return
  liveWanted = true
  if (liveStopTimer !== undefined) {
    clearTimeout(liveStopTimer)
    liveStopTimer = undefined
  }
  if (liveStream !== undefined || liveTimer !== undefined) return
  openLiveStreamNow()
}

/** Stop watching and forget the stream (polling included). */
function stopLive(): void {
  liveWanted = false
  liveGeneration += 1
  liveRetries = 0
  if (liveStopTimer !== undefined) {
    clearTimeout(liveStopTimer)
    liveStopTimer = undefined
  }
  liveStream?.close()
  liveStream = undefined
  stopLivePolling()
}

/**
 * Stop watching once the peer has clearly finished.
 *
 * The events poll says "not running" a moment before the last frames land, so a
 * settled turn waits a beat; a new prompt cancels the wait.
 */
function settleLive(): void {
  if (!liveWanted || liveStopTimer !== undefined) return
  liveStopTimer = setTimeout(() => {
    liveStopTimer = undefined
    if (state.running) return
    stopLive()
  }, 1500)
}

/** Open one stream from where the fold already is. */
function openLiveStreamNow(): void {
  const { target, sessionId } = state
  if (target === undefined || sessionId === undefined) return
  const generation = ++liveGeneration
  liveStream = openLiveStream({
    nodeId: target.nodeId,
    sessionId,
    since: liveState.revision,
    onPage(page) {
      if (generation === liveGeneration) applyLivePage(page)
    },
    onEnd() {
      if (generation !== liveGeneration) return
      liveStream = undefined
      if (!liveWanted) return
      liveRetries += 1
      // A peer that cannot serve the stream (older build, proxy in the middle)
      // degrades to the poll clock instead of leaving the page silent.
      if (liveRetries > 3) {
        startLivePolling()
        return
      }
      setTimeout(() => {
        if (!liveWanted || liveStream !== undefined || liveTimer !== undefined) return
        openLiveStreamNow()
      }, Math.min(400 * liveRetries, 2000))
    },
  })
  if (liveStream !== undefined) liveRetries = 0
}

/** Fold one pushed batch into rows. */
function applyLivePage(page: LivePage): void {
  const cursor = state.events.length === 0 ? 0 : state.events[state.events.length - 1]!.seq
  const folded = foldFrames(liveState, page.frames, cursor)
  if (folded.resync) {
    // A chunk went missing: rebuild the attempt from its start rather than
    // showing a paragraph with a hole in it.
    liveState = EMPTY_LIVE
    liveGeneration += 1
    liveStream?.close()
    liveStream = undefined
    if (liveWanted) openLiveStreamNow()
    return
  }
  if (folded === liveState) return
  liveState = folded
  publish({ ...state, live: folded.entries, revision: state.revision + 1 })
}

/** Forget every folded row (session switch, settlement, leaving the page). */
function resetLive(): void {
  liveState = EMPTY_LIVE
  if (state.live.length !== 0) publish({ ...state, live: [], revision: state.revision + 1 })
}

/**
 * Read the peer's live frames and fold them into rows.
 *
 * The peer keeps a rolling copy per Session; `since` is the last revision this
 * page folded, so a poll returns only what is new. Nothing here waits for the
 * durable log: the rows are what the answer looks like while it is written.
 */
async function pollLive(): Promise<void> {
  if (liveInflight) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const { target, sessionId } = state
  if (target === undefined || sessionId === undefined) { stopLivePolling(); return }
  liveInflight = true
  try {
    const url = new URL('/api/mesh/session/live', globalThis.location.origin)
    url.searchParams.set('nodeId', target.nodeId)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('since', String(liveState.revision))
    const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' })
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (payload === undefined || payload.ok !== true) {
      // A peer that cannot serve live frames (older build, relay without the
      // route) just means the page settles per message; no error surface for it.
      stopLivePolling()
      return
    }
    const frames = Array.isArray(payload.frames) ? payload.frames as never[] : []
    const cursor = state.events.length === 0 ? 0 : state.events[state.events.length - 1]!.seq
    let folded = foldFrames(liveState, frames, cursor)
    if (folded.resync) {
      // Lost frames on the poll clock too: ask for the attempt again from 0.
      liveState = EMPTY_LIVE
      folded = foldFrames(EMPTY_LIVE, frames, cursor)
    }
    if (folded === liveState) {
      liveIdle += 1
      if (liveIdle >= 8 && state.running === false) stopLivePolling()
      return
    }
    liveIdle = 0
    liveState = folded
    publish({ ...state, live: folded.entries, revision: state.revision + 1 })
  } catch {
    liveIdle += 1
    if (liveIdle >= 8) stopLivePolling()
  } finally {
    liveInflight = false
  }
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
    // The peer's Workspace row now owns one more Session: re-read the snapshot
    // so the list can show it instead of waiting for the next wake-up.
    refreshRemoteWorkspaces()
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
    // The durable message replaces the rows that painted it — but only the one
    // for this attempt: a multi-step turn commits earlier messages while the
    // next step is already streaming, and dropping there would blink.
    if (incoming.some(event => settlesLive(event))) liveState = dropEntries(liveState)
    const hasMore = payload.hasMore === true
    const changed = events !== state.events || running !== state.running || hasMore !== state.hasMore
    const liveChanged = liveState.entries !== state.live
    publish({
      ...state,
      phase: 'live',
      error: undefined,
      events,
      hasMore,
      running,
      live: liveState.entries,
      revision: changed || liveChanged ? state.revision + 1 : state.revision,
    })
    if (running) startLive()
    else settleLive()
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

/**
 * The local Session the page borrows as its composer shell.
 *
 * The page runs in a local (blank) Session's scope — the shipped composer and
 * the chat renderer both need one — but that Session is not a conversation on
 * this machine. The workspace list hides it while the page owns the screen, so
 * the page never shows up under a local Workspace directory.
 */
let shellSession: string | undefined
const EMPTY_HIDDEN: readonly string[] = []
let shellSnapshot: readonly string[] = EMPTY_HIDDEN
const shellListeners = new Set<() => void>()

/**
 * Publish (or clears) the borrowed shell Session.
 * @param sessionId - the local Session, or undefined when the page is gone.
 */
export function setShellSession(sessionId: string | undefined): void {
  if (shellSession === sessionId) return
  shellSession = sessionId
  shellSnapshot = sessionId === undefined ? EMPTY_HIDDEN : [sessionId]
  for (const listener of [...shellListeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[remote-mesh] hidden-session subscriber failed:', error)
    }
  }
}

/** The borrowed shell Session as an observable, for the workspace list. */
export const shellSessionSource = {
  getSnapshot: (): readonly string[] => shellSnapshot,
  subscribe: (listener: () => void): (() => void) => {
    shellListeners.add(listener)
    return () => { shellListeners.delete(listener) }
  },
}

/** Start (or keep) the page for one target. */
function begin(target: DispatchTarget): void {
  if (sameTarget(state.target, target)) {
    if (timer === undefined && state.phase !== 'error') startPolling()
    return
  }
  const adoption = adoptFor !== undefined && sameTarget(adoptFor.target, target) ? adoptFor.sessionId : undefined
  adoptFor = undefined
  stopTimer()
  stopLive()
  liveState = EMPTY_LIVE
  publish({ ...IDLE, target, sessionId: adoption, phase: adoption === undefined ? 'idle' : 'live', revision: state.revision + 1 })
  startPolling()
  if (adoption !== undefined) void poll()
}

function startPolling(): void {
  if (timer !== undefined) return
  timer = setInterval(() => { void poll() }, 900)
}

/** Leave the page and forget the peer Session. */
function end(): void {
  stopTimer()
  stopLive()
  liveState = EMPTY_LIVE
  setShellSession(undefined)
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
 * Open one existing peer Session in the page.
 *
 * Clicking a Session in the sidebar is a read: it must not create anything on
 * the peer, and it must not append to whatever the page was showing before.
 * @param target - the Workspace the Session lives in.
 * @param sessionId - the Session to show.
 */
export function openRemoteSession(target: DispatchTarget, sessionId: string): void {
  if (sameTarget(state.target, target)) {
    adopt(target, sessionId)
    return
  }
  // The target store is the page's switch; the subscription that follows it
  // resets the page, so the Session to adopt travels with the switch.
  adoptFor = { target, sessionId }
  setDispatchTarget(target)
}

/** One Session to adopt as soon as the page for this target exists. */
let adoptFor: { target: DispatchTarget, sessionId: string } | undefined

/** Show one Session now: new window, new fold, polling restarted. */
function adopt(target: DispatchTarget, sessionId: string): void {
  stopTimer()
  stopLive()
  liveState = EMPTY_LIVE
  publish({ ...IDLE, target, sessionId, phase: 'live', revision: state.revision + 1 })
  void poll()
  startPolling()
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
    // Show the user's own row without waiting a full poll interval, and start
    // folding the answer as soon as the peer begins writing it.
    void poll()
    startPolling()
    startLive()
  } catch (error) {
    publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Whether one durable event ends the attempt the live rows belong to.
 * @param event - a freshly read durable event.
 * @returns true when the rows painted by that attempt must go.
 */
function settlesLive(event: RemoteEvent): boolean {
  if (liveState.entries.length === 0 && liveState.attemptId === undefined) return false
  if (event.type === 'turn/end') return true
  if (event.type !== 'assistant/message') return false
  const data = event.data as { turn?: unknown, step?: unknown } | undefined
  if (typeof data?.turn !== 'number') return true
  if (data.turn > liveState.turn) return true
  if (data.turn < liveState.turn) return false
  return typeof data.step !== 'number' || data.step >= liveState.step
}

/** Read the page state as React state. */
export function useRemotePageState(): RemotePageState {
  return useSyncExternalStore(subscribeRemotePage, remotePageState, remotePageState)
}