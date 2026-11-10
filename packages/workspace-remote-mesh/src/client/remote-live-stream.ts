/**
 * Read a peer's live frames as they happen.
 *
 * The page used to poll for them on a fixed clock: the answer then arrived in
 * batches whose size was the interval, not the model's output. One open event
 * stream carries each batch the moment the peer produced it, and the Host on
 * this side already streams (browser fence and peer relay both).
 *
 * The handle is deliberately tiny: it reports batches and says when the stream
 * ended, and the caller decides whether to reopen, fall back to polling, or stop.
 */
import type { LiveFrame } from './remote-live'

/** One batch of frames, as handed to a reader. */
export interface LivePage {
  /** Highest revision the peer has produced so far. */
  readonly revision: number
  /** Frames newer than the reader's revision. */
  readonly frames: readonly LiveFrame[]
}

/** An open stream; closing it stops the peer's producer too. */
export interface LiveStreamHandle {
  close(): void
}

/**
 * Open the peer's live frame stream through this Host.
 *
 * The Host owns the peer connection and the credential; the browser only talks
 * to its own origin, so the cookie the fence already issued is enough.
 * @param options - peer Session, where to resume, and the two sinks.
 * @returns the open handle.
 */
export function openLiveStream(options: {
  nodeId: string
  sessionId: string
  since: number
  onPage: (page: LivePage) => void
  onEnd: () => void
}): LiveStreamHandle {
  const url = new URL('/api/mesh/session/live/stream', globalThis.location.origin)
  url.searchParams.set('nodeId', options.nodeId)
  url.searchParams.set('sessionId', options.sessionId)
  url.searchParams.set('since', String(Math.max(0, Math.floor(options.since))))

  const source = new EventSource(url.toString())
  let closed = false

  const end = (): void => {
    if (closed) return
    closed = true
    source.close()
    options.onEnd()
  }

  source.addEventListener('message', (event: MessageEvent<string>) => {
    if (closed) return
    if (typeof event.data !== 'string' || event.data === '') return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.type === 'frames') {
      options.onPage({
        revision: typeof payload.revision === 'number' ? payload.revision : 0,
        frames: Array.isArray(payload.frames) ? payload.frames as LiveFrame[] : [],
      })
      return
    }
    if (payload.type === 'error') end()
  })
  // The stream dropped (peer restart, proxy timeout): the caller resumes from
  // the revision it already folded, so nothing is lost by closing here.
  source.addEventListener('error', () => { end() })

  return {
    close() {
      if (closed) {
        source.close()
        return
      }
      closed = true
      source.close()
    },
  }
}
