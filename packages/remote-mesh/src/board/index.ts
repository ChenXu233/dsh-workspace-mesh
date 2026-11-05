import type { Lease, Task, TaskState } from '../types.js'

export interface TaskListFilter {
  state?: TaskState
  nodeId?: string
}

/** A write may be fenced to one lease epoch (SPEC §6.3: stale writers must lose). */
export interface LeaseFence {
  owner: string
  fencingToken: number
}

export interface ClaimOptions {
  /**
   * Session-level mutual exclusion key (SPEC §7.3). claim() derives it from
   * policy.sessionId for resume tasks; a new session is bound after creation
   * with bindSession().
   */
  sessionKey?: string
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
 * - fenced writes are accepted only from the live lease owner with the current token;
 *   a preempted writer's late update returns false and changes nothing
 * - a session key is occupied while its task holds a live lease, enforcing the v1
 *   "one active task per session" rule from SPEC §7.3
 */
export interface TaskBoard {
  /** Returns false when a task with that id already exists; an existing task is never clobbered. */
  create(task: Task): boolean
  /** Returns a defensive copy, so callers cannot mutate lease state behind the board's back. */
  get(taskId: string): Task | undefined
  /**
   * Patch non-identity, non-lease fields. Returns false when the task is unknown.
   * With `fence`, also returns false unless the task's lease is live and still
   * owned by that owner at that fencing epoch.
   */
  update(taskId: string, patch: Partial<Task>, fence?: LeaseFence): boolean
  list(filter?: TaskListFilter): Task[]
  /**
   * Acquire or renew a lease. Returns false when another owner holds a live lease
   * or the derived/explicit session key already has an active task.
   */
  claim(taskId: string, owner: string, ttlMs: number, options?: ClaimOptions): boolean
  /**
   * Bind a created session to the claiming task (SPEC §7.3). Returns false when
   * another task already holds that session key with a live lease.
   */
  bindSession(taskId: string, sessionKey: string): boolean
  /** The task currently holding a session key, or undefined when free. */
  sessionOwner(sessionKey: string): string | undefined
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

function isTerminal(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'expired'
}

function sessionKeyOf(task: Task): string | undefined {
  if (task.policy.sessionMode !== 'resume' || task.policy.sessionId === undefined) return undefined
  return `${task.target.nodeId}\u0000${task.policy.sessionId}`
}

export function createInMemoryBoard(now: () => number = Date.now): TaskBoard {
  const tasks = new Map<string, Task>()
  /** sessionKey -> taskId; entries are validated against a live lease on read. */
  const sessions = new Map<string, string>()

  const activeSessionHolder = (sessionKey: string, at: number): string | undefined => {
    const taskId = sessions.get(sessionKey)
    if (taskId === undefined) return undefined
    const task = tasks.get(taskId)
    if (task === undefined || !isLive(task.lease, at)) {
      sessions.delete(sessionKey)
      return undefined
    }
    return taskId
  }

  const releaseSession = (taskId: string): void => {
    for (const [key, owner] of sessions) {
      if (owner === taskId) sessions.delete(key)
    }
  }

  const claimSession = (taskId: string, sessionKey: string, at: number): boolean => {
    const holder = activeSessionHolder(sessionKey, at)
    if (holder !== undefined && holder !== taskId) return false
    sessions.set(sessionKey, taskId)
    return true
  }

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

    update(taskId, patch, fence) {
      const current = tasks.get(taskId)
      if (!current) return false
      const at = now()
      if (fence !== undefined) {
        // Fencing is not advisory: an expired or superseded writer loses every field.
        if (!isLive(current.lease, at)) return false
        if (current.lease.owner !== fence.owner || current.lease.fencingToken !== fence.fencingToken) return false
      }
      // taskId and lease are owned by create/claim/release; a patch must not bypass fencing.
      const { taskId: _ignoredId, lease: _ignoredLease, ...rest } = patch
      tasks.set(taskId, { ...current, ...rest, taskId: current.taskId, updatedAt: at })
      if (rest.state !== undefined && isTerminal(rest.state)) releaseSession(taskId)
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

    claim(taskId, owner, ttlMs, options) {
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

      // SPEC §7.3: one active task per session, checked before any lease mutation.
      const sessionKey = options?.sessionKey ?? sessionKeyOf(task)
      if (sessionKey !== undefined && !claimSession(taskId, sessionKey, at)) return false

      tasks.set(taskId, {
        ...task,
        lease: { owner, fencingToken, expiresAt: at + ttlMs },
        updatedAt: at,
      })
      return true
    },

    bindSession(taskId, sessionKey) {
      const task = tasks.get(taskId)
      if (task === undefined) return false
      const at = now()
      if (!isLive(task.lease, at)) return false
      return claimSession(taskId, sessionKey, at)
    },

    sessionOwner(sessionKey) {
      return activeSessionHolder(sessionKey, now())
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
      releaseSession(taskId)
      return true
    },
  }
}
