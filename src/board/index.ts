import type { Lease, Task, TaskState } from '../types.js'

export interface TaskListFilter {
  state?: TaskState
  nodeId?: string
}

/**
 * Task board with the state machine from SPEC §7 and §6.3.
 * In-memory for v1; the interface is what the durable store will implement later.
 *
 * Lease semantics (SPEC §6.3, §7.2, §7.3):
 * - a lease is *live* while `expiresAt > now`; at exactly its expiry instant it is stealable
 * - a live lease held by someone else rejects the claim without touching any field
 * - a live lease held by the caller is a renewal: TTL extended, fencingToken unchanged
 * - any claim that starts a new epoch (expired or released lease) increments fencingToken,
 *   so the token is strictly increasing for the whole life of a task
 */
export interface TaskBoard {
  /** Returns false when a task with that id already exists; an existing task is never clobbered. */
  create(task: Task): boolean
  /** Returns a defensive copy, so callers cannot mutate lease state behind the board's back. */
  get(taskId: string): Task | undefined
  /** Patch non-identity, non-lease fields. Returns false when the task is unknown. */
  update(taskId: string, patch: Partial<Task>): boolean
  list(filter?: TaskListFilter): Task[]
  /** Acquire or renew a lease. Returns false when another owner holds a live lease. */
  claim(taskId: string, owner: string, ttlMs: number): boolean
  /**
   * Clear the lease. With `owner` the release is owner-guarded: a non-matching owner
   * leaves the lease intact and returns false. Without it the lease is cleared
   * unconditionally (admin/hub path).
   */
  release(taskId: string, owner?: string): boolean
}

function copyTask(task: Task): Task {
  return { ...task, target: { ...task.target }, lease: { ...task.lease } }
}

function isLive(lease: Lease, at: number): boolean {
  return lease.owner !== '' && lease.expiresAt > at
}

export function createInMemoryBoard(now: () => number = Date.now): TaskBoard {
  const tasks = new Map<string, Task>()

  return {
    create(task) {
      if (tasks.has(task.taskId)) return false
      tasks.set(task.taskId, copyTask(task))
      return true
    },

    get(taskId) {
      const task = tasks.get(taskId)
      return task ? copyTask(task) : undefined
    },

    update(taskId, patch) {
      const current = tasks.get(taskId)
      if (!current) return false
      // taskId and lease are owned by create/claim/release; a patch must not bypass fencing.
      const { taskId: _ignoredId, lease: _ignoredLease, ...rest } = patch
      tasks.set(taskId, { ...current, ...rest, taskId: current.taskId, updatedAt: now() })
      return true
    },

    list(filter) {
      const all = [...tasks.values()]
      const matched = filter
        ? all.filter(
            (task) =>
              (filter.state === undefined || task.state === filter.state) &&
              (filter.nodeId === undefined || task.target.nodeId === filter.nodeId),
          )
        : all
      return matched.map(copyTask)
    },

    claim(taskId, owner, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError(`lease ttlMs must be a positive finite number, got ${ttlMs}`)
      }
      if (owner === '') {
        throw new RangeError('lease owner must be a non-empty string')
      }
      const task = tasks.get(taskId)
      if (!task) return false
      const at = now()
      const current = task.lease
      const live = isLive(current, at)
      if (live && current.owner !== owner) return false
      const renewing = live && current.owner === owner
      const fencingToken = renewing ? current.fencingToken : current.fencingToken + 1
      tasks.set(taskId, {
        ...task,
        lease: { owner, fencingToken, expiresAt: at + ttlMs },
        updatedAt: at,
      })
      return true
    },

    release(taskId, owner) {
      const task = tasks.get(taskId)
      if (!task) return false
      if (owner !== undefined && task.lease.owner !== owner) return false
      tasks.set(taskId, {
        ...task,
        lease: { owner: '', fencingToken: task.lease.fencingToken, expiresAt: 0 },
        updatedAt: now(),
      })
      return true
    },
  }
}
