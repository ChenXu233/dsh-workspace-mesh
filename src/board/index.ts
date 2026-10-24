import type { Task, TaskState } from '../types.js'

/**
 * Task board with the state machine from SPEC §7 and §6.3.
 * In-memory for v1; the interface is what the durable store will implement later.
 */
export interface TaskBoard {
  create(task: Task): void
  get(taskId: string): Task | undefined
  update(taskId: string, patch: Partial<Task>): void
  list(filter?: { state?: TaskState; nodeId?: string }): Task[]
  /** Acquire or renew a lease. Returns false when another live owner holds it. */
  claim(taskId: string, owner: string, ttlMs: number): boolean
  release(taskId: string): void
}

export function createInMemoryBoard(now: () => number = Date.now): TaskBoard {
  const tasks = new Map<string, Task>()

  return {
    create(task) {
      tasks.set(task.taskId, task)
    },
    get(taskId) {
      return tasks.get(taskId)
    },
    update(taskId, patch) {
      const cur = tasks.get(taskId)
      if (!cur) return
      tasks.set(taskId, { ...cur, ...patch, updatedAt: now() })
    },
    list(filter) {
      const all = [...tasks.values()]
      if (!filter) return all
      return all.filter(
        (t) =>
          (filter.state === undefined || t.state === filter.state) &&
          (filter.nodeId === undefined || t.target.nodeId === filter.nodeId),
      )
    },
    claim(taskId, owner, ttlMs) {
      const t = tasks.get(taskId)
      if (!t) return false
      const live = t.lease.expiresAt > now() && t.lease.owner !== owner
      if (live) return false
      const fencingToken = t.lease.owner === owner ? t.lease.fencingToken : t.lease.fencingToken + 1
      tasks.set(taskId, { ...t, lease: { owner, fencingToken, expiresAt: now() + ttlMs }, updatedAt: now() })
      return true
    },
    release(taskId) {
      const t = tasks.get(taskId)
      if (!t) return
      tasks.set(taskId, { ...t, lease: { ...t.lease, owner: '', expiresAt: 0 }, updatedAt: now() })
    },
  }
}
