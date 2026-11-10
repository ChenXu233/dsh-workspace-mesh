/**
 * Server-sent events, for readings that must arrive as they happen.
 *
 * The browser and the Host both read a peer's live frames; polling them at a
 * fixed interval makes the answer arrive in bursts whose size is the interval,
 * not the model's. One response that stays open carries each batch the moment
 * the peer produces it, and both hops of this plugin already stream: the browser
 * fence pipes `Response.body` chunk by chunk, and the peer-facing routes write
 * to the Node response directly.
 */

/** One piece written to an open stream. */
export type SseWrite = (payload: unknown) => void

/**
 * Build an event-stream response.
 *
 * @param open - starts the producer and returns its teardown; every call to the
 * writer emits one `data:` event.
 * @param signal - aborts when the reader goes away; the teardown still runs.
 * @returns the response to hand back to the transport.
 */
export function sseResponse(open: (write: SseWrite) => () => void, signal?: AbortSignal): Response {
  const encoder = new TextEncoder()
  let stop: (() => void) | undefined
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined

  const finish = (): void => {
    if (closed) return
    closed = true
    const teardown = stop
    stop = undefined
    try {
      teardown?.()
    } catch {
      // The producer's own teardown may throw when its source is already gone.
    }
    try {
      controller?.close()
    } catch {
      // The reader cancelled first; there is nothing left to close.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner
      const write: SseWrite = (payload) => {
        if (closed) return
        try {
          inner.enqueue(encoder.encode('data: ' + JSON.stringify(payload) + '\n\n'))
        } catch {
          finish()
        }
      }
      stop = open(write)
      if (signal !== undefined) {
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }
    },
    cancel() {
      finish()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // A reverse proxy that buffers would defeat the whole point.
      'x-accel-buffering': 'no',
    },
  })
}
