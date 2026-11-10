/**
 * Live assistant frames, kept for readers on other machines.
 *
 * A Session's transcript is durable events: one committed message arrives when
 * the turn is finished, so a reader on another machine would see the answer
 * appear whole. The Host also emits dense process-local frames while the model
 * is producing text (`agent/assistant-stream`); the browser folds them into a
 * transient row and paints tokens as they arrive.
 *
 * Those frames never reach the durable log, so this module keeps a short rolling
 * copy per Session and hands out everything a reader has not seen yet. Nothing
 * here interprets the chunks: the peer's browser folds them exactly like this
 * machine's would, and only the fold owner knows how to render them.
 */
import type { Context } from '@deepseek-ai/cordis'

/** One Assistant frame, already in the shape the browser folds. */
export type LiveFrame =
  | {
    readonly type: 'start'
    readonly attemptId: string
    readonly revision: number
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: unknown
  }
  | {
    readonly type: 'end'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly outcome: { kind?: string, seq?: number, eventType?: string }
  }

/** What one reader gets back for "everything after revision N". */
export interface LivePage {
  /** Highest revision this Session has produced so far. */
  readonly revision: number
  /** Frames newer than the requested revision, oldest first. */
  readonly frames: readonly LiveFrame[]
}

/** Frames retained per Session: a slow reader falls behind, it does not grow the Host. */
const RETAINED_FRAMES = 4000

/** The Host throws the frames away once the Agent is gone, so the map stays bounded by live Agents. */
interface Retained {
  revision: number
  frames: LiveFrame[]
}

/** Payload of the Host's `agent/assistant-stream` event, as this plugin reads it. */
interface StreamPayload {
  readonly agent?: { readonly session?: { readonly id?: unknown, readonly seq?: unknown } }
  readonly frame?: {
    readonly type?: unknown
    readonly attemptId?: unknown
    readonly revision?: unknown
    readonly index?: unknown
    readonly time?: unknown
    readonly turn?: unknown
    readonly step?: unknown
    readonly chunk?: unknown
    readonly outcome?: unknown
  }
}

/**
 * Rolling per-Session copy of the Agent's live frames.
 *
 * The Hub only listens: it never drives the Agent, and a Session with no Agent
 * simply has nothing to hand out.
 */
export class AssistantLiveHub {
  private readonly streams = new Map<string, Retained>()
  /** Readers waiting for the next frame of one Session. */
  private readonly readers = new Map<string, Set<(page: LivePage) => void>>()

  /**
   * @param ctx - any Host context; the listener is global so Agents on other fibers are seen too.
   */
  constructor(ctx: Context) {
    const events = ctx as unknown as {
      on?(name: string, fn: (payload: StreamPayload) => void, options?: { global?: boolean }): () => void
    }
    if (typeof events.on !== 'function') {
      // A composition without an event bus (tests, a headless build) simply has
      // no frames to retain; asking for them then reports `unavailable`.
      this.dispose = () => {
        this.streams.clear()
      }
      return
    }
    const listen = events.on.bind(events)
    const dispose = listen('agent/assistant-stream', payload => { this.accept(payload) }, { global: true })
    const forget = listen('agent/disposed', payload => {
      const id = payload.agent?.session?.id
      if (typeof id === 'string') this.streams.delete(id)
    }, { global: true })
    this.dispose = () => {
      dispose()
      forget()
      this.streams.clear()
    }
  }

  private readonly dispose: () => void

  /** Stop listening; the retained frames go with it. */
  release(): void {
    this.dispose()
  }

  /**
   * Keep one frame for its Session.
   * @param payload - the Host's event payload.
   */
  private accept(payload: StreamPayload): void {
    const sessionId = payload.agent?.session?.id
    const frame = payload.frame
    if (typeof sessionId !== 'string' || frame === undefined) return
    if (typeof frame.attemptId !== 'string' || typeof frame.revision !== 'number') return
    const seq = typeof payload.agent?.session?.seq === 'number' ? payload.agent.session.seq : 0
    let stream = this.streams.get(sessionId)
    if (stream === undefined) {
      stream = { revision: 0, frames: [] }
      this.streams.set(sessionId, stream)
    }
    // A new attempt after a Host restart starts again at revision 1; the retained
    // frames belong to the old generation and would never be matched again.
    if (frame.type === 'start' && frame.revision === 1 && stream.revision !== 0) {
      stream.frames = []
      stream.revision = 0
    }
    const revision = frame.revision
    if (revision !== stream.revision + 1) {
      // A gap means this Session was replaced or the Host restarted. Drop the old
      // generation instead of handing a reader frames that cannot be folded.
      stream.frames = []
      stream.revision = revision
      return
    }
    stream.revision = revision
    let pushed: LiveFrame | undefined
    switch (frame.type) {
      case 'start':
        pushed = {
          type: 'start',
          attemptId: frame.attemptId,
          revision,
          startedAfterSeq: seq === 0 ? -1 : seq - 1,
          turn: typeof frame.turn === 'number' ? frame.turn : 0,
          step: typeof frame.step === 'number' ? frame.step : 0,
        }
        break
      case 'chunk':
        pushed = {
          type: 'chunk',
          attemptId: frame.attemptId,
          revision,
          index: typeof frame.index === 'number' ? frame.index : 0,
          time: typeof frame.time === 'number' ? frame.time : Date.now(),
          chunk: frame.chunk,
        }
        break
      case 'end': {
        const outcome = (frame.outcome ?? {}) as { kind?: unknown, seq?: unknown, eventType?: unknown }
        pushed = {
          type: 'end',
          attemptId: frame.attemptId,
          revision,
          index: typeof frame.index === 'number' ? frame.index : 0,
          outcome: {
            ...(typeof outcome.kind === 'string' ? { kind: outcome.kind } : {}),
            ...(typeof outcome.seq === 'number' ? { seq: outcome.seq } : {}),
            ...(typeof outcome.eventType === 'string' ? { eventType: outcome.eventType } : {}),
          },
        }
        break
      }
      default:
        break
    }
    if (pushed !== undefined) {
      stream.frames.push(pushed)
      if (stream.frames.length > RETAINED_FRAMES) stream.frames = stream.frames.slice(-RETAINED_FRAMES)
      this.notify(sessionId, [pushed], stream.revision)
    }
  }

  /**
   * Wait for the next frames of one Session.
   * @param sessionId - the Session to follow.
   * @param listener - called once per accepted frame batch.
   * @returns unsubscribe.
   */
  subscribe(sessionId: string, listener: (page: LivePage) => void): () => void {
    let readers = this.readers.get(sessionId)
    if (readers === undefined) {
      readers = new Set()
      this.readers.set(sessionId, readers)
    }
    readers.add(listener)
    return () => {
      readers.delete(listener)
      if (readers.size === 0) this.readers.delete(sessionId)
    }
  }

  /** Hand one batch to everyone waiting on that Session. */
  private notify(sessionId: string, frames: readonly LiveFrame[], revision: number): void {
    const readers = this.readers.get(sessionId)
    if (readers === undefined || readers.size === 0) return
    const page: LivePage = { revision, frames }
    for (const reader of [...readers]) {
      try {
        reader(page)
      } catch {
        // A reader that threw (its socket died) is dropped by its own disposer.
      }
    }
  }

  /**
   * Read everything newer than one revision.
   * @param sessionId - the Session to read.
   * @param since - last revision the reader folded; 0 asks for the whole attempt.
   * @returns the current revision and the unseen frames.
   */
  read(sessionId: string, since: number): LivePage {
    const stream = this.streams.get(sessionId)
    if (stream === undefined) return { revision: 0, frames: [] }
    if (since >= stream.revision) return { revision: stream.revision, frames: [] }
    const frames = stream.frames.filter(frame => frame.revision > since)
    return { revision: stream.revision, frames }
  }

  /**
   * Whether a Session currently has live frames at all.
   * @param sessionId - the Session to check.
   * @returns true while an Agent is producing frames there.
   */
  has(sessionId: string): boolean {
    const stream = this.streams.get(sessionId)
    return stream !== undefined && stream.revision > 0
  }
}