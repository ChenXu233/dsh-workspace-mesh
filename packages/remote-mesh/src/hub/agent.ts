/**
 * The joining side of a hub.
 *
 * A node behind NAT has no inbound port, so the hub cannot dial it. Instead the
 * node holds a long poll open and takes whole requests off the wire, runs them
 * against its own handlers, and posts the answer back. Outbound only — which is
 * exactly what a NAT'd machine can do.
 *
 * The agent also keeps the directory: every poll carries the current node list,
 * so joining a hub is one request and everybody learns about everybody without
 * the hub ever dialling anyone.
 */
import { MESH_TOKEN_TTL_MS, mintMeshToken } from '../api/mesh-auth.js'
import { MESH_HUB_INBOX_PATH, MESH_HUB_JOIN_PATH, MESH_HUB_RESULT_PATH } from '../api/hub.js'

/** One request taken off the hub's queue. */
export interface HubDelivery {
  readonly id: string
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** What this node answers with. */
export interface HubDeliveryResult {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

/** A directory row as the hub reports it. */
export interface HubNodeView {
  readonly nodeId: string
  readonly url: string
}

export interface HubAgentOptions {
  /** Hub origin, e.g. `https://hub.example`. */
  hubUrl: string
  /** This node's id in the directory. */
  nodeId: string
  /** Address other nodes can dial for this one; empty = relay only. */
  publicUrl: () => string
  /** Shared secret with the hub. */
  secret: () => string
  /** Run one delivery against this node's own handlers. */
  dispatch: (delivery: HubDelivery) => Promise<HubDeliveryResult>
  /** New directory contents (including this node). */
  onDirectory?: (nodes: readonly HubNodeView[]) => void
  /** How long one poll is held open on the hub. */
  waitMs?: number
  /** Backoff floor after a failed poll. */
  retryMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Long-poll budget; the hub caps it at 25s. */
const DEFAULT_WAIT_MS = 20_000
/** First retry delay; doubles to the ceiling. */
const DEFAULT_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/** Rolling agent: join once, then poll until stopped. */
export class HubAgent {
  private readonly options: HubAgentOptions
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private stopped = false
  private running: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastDirectoryKey = ''
  /** Why the last round failed; surfaced to the status surface. */
  lastError = ''

  constructor(options: HubAgentOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** Start the loop; idempotent. */
  start(): void {
    if (this.running !== undefined) return
    this.stopped = false
    this.running = this.loop()
  }

  /** Stop the loop and wait for the in-flight round. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const running = this.running
    this.running = undefined
    if (running !== undefined) await running.catch(() => {})
  }

  /** Join and poll forever, backing off on failure. */
  private async loop(): Promise<void> {
    let backoff = this.options.retryMs ?? DEFAULT_RETRY_MS
    while (!this.stopped) {
      try {
        await this.round()
        backoff = this.options.retryMs ?? DEFAULT_RETRY_MS
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_RETRY_MS)
      }
    }
  }

  /** One join + one poll. */
  private async round(): Promise<void> {
    const token = this.token()
    const joined = await this.post(MESH_HUB_JOIN_PATH, {
      token,
      nodeId: this.options.nodeId,
      url: this.options.publicUrl(),
    })
    const peers = (joined as { peers?: HubNodeView[] }).peers ?? []
    this.publishDirectory([...(joined as { node?: HubNodeView }).node ? [(joined as { node: HubNodeView }).node] : [], ...peers])

    const wait = this.options.waitMs ?? DEFAULT_WAIT_MS
    const url = new URL(MESH_HUB_INBOX_PATH, this.options.hubUrl)
    url.searchParams.set('token', this.token())
    url.searchParams.set('nodeId', this.options.nodeId)
    url.searchParams.set('wait', String(wait))
    const response = await this.fetchImpl(url.toString(), { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error('hub inbox answered HTTP ' + response.status)
    const body = (await response.json()) as {
      ok?: boolean
      job?: HubDelivery | null
      nodes?: HubNodeView[]
      error?: string
    }
    if (body.ok !== true) throw new Error(body.error ?? 'hub inbox refused')
    if (Array.isArray(body.nodes)) this.publishDirectory(body.nodes)
    this.lastError = ''
    const job = body.job
    if (job === undefined || job === null) return
    await this.serve(job)
  }

  /** Run one delivery and post the answer back. */
  private async serve(job: HubDelivery): Promise<void> {
    let result: HubDeliveryResult
    try {
      result = await this.options.dispatch(job)
    } catch (err) {
      result = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), 'utf8').toString('base64'),
      }
    }
    await this.post(MESH_HUB_RESULT_PATH, {
      token: this.token(),
      id: job.id,
      status: result.status,
      headers: result.headers ?? {},
      ...(result.body === undefined ? {} : { body: result.body }),
    })
  }

  /** POST JSON to the hub. */
  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.options.hubUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('hub ' + path + ' answered HTTP ' + response.status)
    return await response.json()
  }

  /** Hand the directory to the owner only when it actually changed. */
  private publishDirectory(nodes: readonly HubNodeView[]): void {
    const key = nodes.map(node => node.nodeId + '|' + node.url).sort().join(',')
    if (key === this.lastDirectoryKey) return
    this.lastDirectoryKey = key
    this.options.onDirectory?.(nodes)
  }

  /** A short-lived token minted from the shared secret. */
  private token(): string {
    return mintMeshToken(this.options.secret(), {
      nodeId: this.options.nodeId,
      expiresAt: this.now() + MESH_TOKEN_TTL_MS,
    })
  }

  /** Sleep, cancellable by stop(). */
  private async sleep(ms: number): Promise<void> {
    if (this.stopped) return
    await new Promise<void>((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = undefined
        resolve()
      }, ms)
    })
  }
}
