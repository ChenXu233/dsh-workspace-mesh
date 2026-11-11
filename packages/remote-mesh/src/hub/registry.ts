/**
 * The hub's directory and request buffer.
 *
 * Two jobs, both in memory and both small:
 *
 * 1. **Directory** — which nodes exist, what address each can be dialled at, and
 *    when it was last heard from. A joining node gets the list, and every node
 *    gets told about the new one, so nobody copies an address by hand.
 * 2. **Request buffer** — a node with no inbound port polls
 *    \`/api/mesh/hub/inbox\` and takes whole HTTP requests off a per-node queue,
 *    then posts the result back. The hub therefore moves bytes, never runs work.
 *
 * Nothing here is durable: a hub restart forgets the directory and fails the
 * in-flight forwards, which the caller sees as a network error and retries. That
 * is the honest behaviour for a rendezvous process — pretending to have state it
 * does not have would be worse.
 */

/** One node as the hub knows it. */
export interface HubNodeRecord {
  readonly nodeId: string
  /** Address other machines can dial directly; empty means relay-only. */
  readonly url: string
  readonly joinedAt: number
  lastSeenAt: number
}

/** One HTTP request the hub hands to a node. */
export interface ForwardEnvelope {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  /** Base64 body; absent for bodyless methods. */
  readonly body?: string
}

/** What the node answers with. */
export interface ForwardResult {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  /** Base64 body. */
  readonly body?: string
}

/** A queued forward: one caller waiting for one node. */
interface ForwardJob {
  readonly id: string
  readonly nodeId: string
  readonly envelope: ForwardEnvelope
  readonly createdAt: number
  readonly settle: (result: ForwardResult) => void
  readonly fail: (reason: string) => void
}

interface NodeState {
  record: HubNodeRecord
  readonly queue: ForwardJob[]
  /** Long-poll waiting for the next job, or undefined when nobody is waiting. */
  waiter?: { resolve: (job: ForwardJob | undefined) => void }
}

/** Default time a caller waits for the node to answer. */
export const FORWARD_TIMEOUT_MS = 30_000
/** Longest a poll is held open; shorter than most proxy idle timeouts. */
export const MAX_POLL_MS = 25_000

/** The hub's whole state: directory plus one queue per node. */
export class HubRegistry {
  private readonly nodes = new Map<string, NodeState>()
  private readonly jobs = new Map<string, ForwardJob>()
  private readonly now: () => number
  private counter = 0

  /**
   * @param now - clock (tests pin it).
   */
  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Add or refresh one node.
   * @param input - node id and its dialable address (empty for relay-only).
   * @returns the stored record and the other nodes it should learn about.
   */
  join(input: { nodeId: string; url?: string }): { node: HubNodeRecord; peers: HubNodeRecord[] } {
    const at = this.now()
    const existing = this.nodes.get(input.nodeId)
    const record: HubNodeRecord = {
      nodeId: input.nodeId,
      url: (input.url ?? '').trim(),
      joinedAt: existing?.record.joinedAt ?? at,
      lastSeenAt: at,
    }
    const next: NodeState = existing ?? { record, queue: [] }
    // Rebuild rather than mutate: the record is exposed to readers as-is.
    const state: NodeState = { record, queue: next.queue, ...(next.waiter === undefined ? {} : { waiter: next.waiter }) }
    this.nodes.set(record.nodeId, state)
    return {
      node: record,
      peers: [...this.nodes.values()]
        .map(entry => entry.record)
        .filter(entry => entry.nodeId !== record.nodeId),
    }
  }

  /** Mark a node seen without changing what it advertised. */
  touch(nodeId: string): void {
    const state = this.nodes.get(nodeId)
    if (state === undefined) return
    state.record.lastSeenAt = this.now()
  }

  /** Directory snapshot, newest first. */
  directory(): HubNodeRecord[] {
    return [...this.nodes.values()].map(state => state.record).sort((left, right) => right.lastSeenAt - left.lastSeenAt)
  }

  /** How many requests are waiting for one node. */
  pending(nodeId: string): number {
    return this.nodes.get(nodeId)?.queue.length ?? 0
  }

  /**
   * Queue one request and wait for that node to answer it.
   * @param nodeId - target node.
   * @param envelope - request to run there.
   * @param timeoutMs - how long the caller is willing to wait.
   * @returns the node's answer.
   */
  enqueue(nodeId: string, envelope: ForwardEnvelope, timeoutMs: number = FORWARD_TIMEOUT_MS): Promise<ForwardResult> {
    const state = this.nodes.get(nodeId)
    if (state === undefined) return Promise.reject(new Error('unknown hub node ' + nodeId))
    return new Promise<ForwardResult>((resolve, reject) => {
      const id = 'f' + (this.counter += 1)
      const timer = setTimeout(() => {
        const index = state.queue.findIndex(job => job.id === id)
        if (index >= 0) state.queue.splice(index, 1)
        this.jobs.delete(id)
        reject(new Error('node ' + nodeId + ' did not answer within ' + timeoutMs + 'ms'))
      }, timeoutMs)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
      const job: ForwardJob = {
        id,
        nodeId,
        envelope,
        createdAt: this.now(),
        settle: (result) => {
          clearTimeout(timer)
          this.jobs.delete(id)
          resolve(result)
        },
        fail: (reason) => {
          clearTimeout(timer)
          this.jobs.delete(id)
          reject(new Error(reason))
        },
      }
      state.queue.push(job)
      this.jobs.set(id, job)
      // A poll already waiting takes the job immediately.
      const waiter = state.waiter
      if (waiter !== undefined) {
        state.waiter = undefined
        waiter.resolve(state.queue.shift())
      }
    })
  }

  /**
   * Take the next request for a node, waiting up to `waitMs`.
   * @param nodeId - polling node.
   * @param waitMs - long-poll budget.
   * @returns the next job, or undefined when the budget ran out.
   */
  async take(nodeId: string, waitMs: number): Promise<{ id: string; envelope: ForwardEnvelope } | undefined> {
    const state = this.nodes.get(nodeId)
    if (state === undefined) return undefined
    this.touch(nodeId)
    const next = state.queue.shift()
    if (next !== undefined) return { id: next.id, envelope: next.envelope }
    const budget = Math.max(0, Math.min(waitMs, MAX_POLL_MS))
    if (budget === 0) return undefined
    return await new Promise((resolve) => {
      let done = false
      const finish = (job: ForwardJob | undefined): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (state.waiter !== undefined && state.waiter.resolve === finish) state.waiter = undefined
        resolve(job === undefined ? undefined : { id: job.id, envelope: job.envelope })
      }
      const timer = setTimeout(() => { finish(undefined) }, budget)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
      state.waiter = { resolve: finish }
    })
  }

  /**
   * Deliver a node's answer to the waiting caller.
   * @param id - job id the node was given.
   * @param result - what it produced.
   * @returns whether a caller was waiting (false = it timed out already).
   */
  settle(id: string, result: ForwardResult): boolean {
    const job = this.jobs.get(id)
    if (job === undefined) return false
    job.settle(result)
    return true
  }

  /** Drop a node and fail everything queued for it. */
  leave(nodeId: string, reason: string = 'node left the hub'): void {
    const state = this.nodes.get(nodeId)
    if (state === undefined) return
    this.nodes.delete(nodeId)
    for (const job of state.queue) job.fail(reason)
    state.waiter?.resolve(undefined)
  }

  /** Node count, for the status surface. */
  size(): number {
    return this.nodes.size
  }
}
