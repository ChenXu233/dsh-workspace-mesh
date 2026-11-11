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
 * The **directory** is persisted (a restart keeps the node list, so members do
 * not have to re-join); the **queues** are not: an in-flight forward dies with
 * the process and its caller sees a 504 and retries. Buffering requests across a
 * restart would need a durable store and a story for stale work — not worth it
 * for a rendezvous process.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

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
/** One removal, kept for the admin view. */
export interface EvictionRecord {
  readonly nodeId: string
  readonly at: number
  /** Who did it: an admin node id, or 'operator' for a browser session. */
  readonly by: string
  readonly reason: string
}

/** How many removals are remembered. */
const MAX_AUDIT = 20

export const FORWARD_TIMEOUT_MS = 30_000
/** Longest a poll is held open; shorter than most proxy idle timeouts. */
export const MAX_POLL_MS = 25_000

/** The hub's whole state: directory plus one queue per node. */
export class HubRegistry {
  private readonly nodes = new Map<string, NodeState>()
  private readonly jobs = new Map<string, ForwardJob>()
  private readonly audit: EvictionRecord[] = []
  private readonly now: () => number
  private counter = 0

  /**
   * @param now - clock (tests pin it).
   * @param file - where the directory is persisted; empty = memory only.
   */
  constructor(now: () => number = Date.now, private readonly file: string = '') {
    this.now = now
    this.restore()
  }

  /** Load the persisted directory, ignoring anything unreadable. */
  private restore(): void {
    if (this.file === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    const rows = (parsed as { nodes?: unknown }).nodes
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const record = row as Record<string, unknown>
      const nodeId = typeof record.nodeId === 'string' ? record.nodeId : ''
      if (nodeId === '') continue
      const url = typeof record.url === 'string' ? record.url : ''
      this.nodes.set(nodeId, {
        record: {
          nodeId,
          url,
          joinedAt: typeof record.joinedAt === 'number' ? record.joinedAt : this.now(),
          lastSeenAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : 0,
        },
        queue: [],
      })
    }
  }

  /** Write the directory; a failure only loses the next restart's memory. */
  private persist(): void {
    if (this.file === '') return
    const payload = { version: 1, nodes: this.directory() }
    try {
      const temporary = this.file + '.tmp'
      writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      renameSync(temporary, this.file)
    } catch (err) {
      console.warn('[mesh] hub directory not persisted: ' + (err instanceof Error ? err.message : String(err)))
    }
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
    this.persist()
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

  /**
   * Drop a node and fail everything queued for it.
   * @param nodeId - node to remove.
   * @param reason - why (propagated to the callers waiting on that node).
   * @param by - who removed it; recorded in the audit trail.
   * @returns whether a row was removed.
   */
  leave(nodeId: string, reason: string = 'node left the hub', by: string = 'unknown'): boolean {
    const state = this.nodes.get(nodeId)
    if (state === undefined) return false
    this.nodes.delete(nodeId)
    this.persist()
    this.audit.unshift({ nodeId, at: this.now(), by, reason })
    if (this.audit.length > MAX_AUDIT) this.audit.length = MAX_AUDIT
    for (const job of state.queue) job.fail(reason)
    state.waiter?.resolve(undefined)
    return true
  }

  /** Removals, newest first: an operator needs to know who kicked whom. */
  recentEvictions(): ReadonlyArray<EvictionRecord> {
    return this.audit
  }

  /** Node count, for the status surface. */
  size(): number {
    return this.nodes.size
  }
}