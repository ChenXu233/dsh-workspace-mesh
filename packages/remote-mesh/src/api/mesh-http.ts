import type { Context } from '@deepseek-ai/cordis'

/**
 * Raw HTTP registration for the two routes a peer must reach *before* it holds
 * any DSH credential.
 *
 * `ctx.connection.fetch` mounts routes behind the browser fence (a signed cookie
 * or an authenticated Peer), so a handshake registered there is unreachable by a
 * machine that has neither — which defeats the point. `ctx.webServer` sits below
 * that fence; these routes therefore carry their own HMAC/token check and nothing
 * else.
 */

interface NodeRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  write?(chunk: Uint8Array | string): boolean
  flushHeaders?(): void
  once?(event: string, listener: () => void): unknown
  off?(event: string, listener: () => void): unknown
  destroyed?: boolean
  end(body?: string): unknown
}

export interface MeshWebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: NodeRequest, res: NodeResponse) => Promise<void> | void }): unknown
}

export function readWebServer(ctx: unknown): MeshWebServerLike | undefined {
  const candidate = ctx as { get?: (name: string) => unknown; webServer?: unknown } | undefined
  if (candidate === undefined || candidate === null) return undefined
  let service: unknown
  try {
    service = typeof candidate.get === 'function' ? candidate.get('webServer') : candidate.webServer
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  return typeof (service as { register?: unknown }).register === 'function' ? (service as MeshWebServerLike) : undefined
}

async function toRequest(req: NodeRequest): Promise<Request> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
  const headers = new Headers()
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') headers.set('content-type', contentType)
  return new Request(`http://mesh.invalid${req.url ?? '/'}`, {
    method: req.method ?? 'POST',
    headers,
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
  })
}

async function writeResponse(res: NodeResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
  }
  const cache = response.headers.get('cache-control')
  if (cache !== null) headers['cache-control'] = cache
  const body = response.body
  // A peer reading live frames holds the response open; collecting it first
  // would turn a push stream back into one batch at the end.
  if (body !== null && typeof res.write === 'function') {
    res.writeHead(response.status, headers)
    res.flushHeaders?.()
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (res.destroyed === true) break
        if (!res.write(value) && res.once !== undefined) {
          await new Promise<void>((resolve) => {
            const settle = (): void => {
              res.off?.('drain', settle)
              res.off?.('close', settle)
              resolve()
            }
            res.once?.('drain', settle)
            res.once?.('close', settle)
          })
        }
      }
    } catch {
      // The reader went away mid-stream; the socket is already gone.
    }
    try {
      reader.releaseLock()
    } catch {
      // A cancelled reader releases itself.
    }
    try {
      res.end()
    } catch {
      // The socket closed under us.
    }
    return
  }
  const text = await response.text()
  res.writeHead(response.status, headers)
  res.end(text)
}

/**
 * Register one exact-path route on the web server.
 * @returns true when a web server exists and the route was mounted.
 */
export function registerMeshPublicRoute(
  ctx: Context,
  path: string,
  handler: (request: Request) => Promise<Response>,
): boolean {
  const server = readWebServer(ctx)
  if (server === undefined) return false
  const route = {
    kind: 'exact' as const,
    path,
    handler: async (req: NodeRequest, res: NodeResponse): Promise<void> => {
      try {
        await writeResponse(res, await handler(await toRequest(req)))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
    },
  }
  ;(ctx as unknown as { effect?: (fn: () => () => void) => void }).effect?.(() => {
    const dispose = server.register(route)
    return typeof dispose === 'function' ? (dispose as () => void) : () => {}
  })
  if ((ctx as unknown as { effect?: unknown }).effect === undefined) server.register(route)
  return true
}