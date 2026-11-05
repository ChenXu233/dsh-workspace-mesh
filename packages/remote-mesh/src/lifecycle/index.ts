/**
 * Lifecycle control — SPEC §14.
 *
 * Path A only: the plugin never spawns a process and never touches a shell.
 * It turns "please restart" into an ordinary process exit; whatever supervises
 * the host (systemd / docker / pm2) is responsible for bringing it back.
 */
export type LifecycleState = 'running' | 'draining' | 'offline'

export interface LifecycleStatus {
  state: LifecycleState
  pid: number
  startedAt: number
  /** How the host was started, when it can be inferred. Never used to spawn anything. */
  supervisor: 'systemd' | 'docker' | 'pm2' | 'unknown'
}

export interface LifecycleController {
  status(): LifecycleStatus
  /** Drain in-flight work, then exit so the supervisor restarts us. Idempotent. */
  requestRestart(reason: string): void
  onDrain(listener: () => Promise<void> | void): () => void
}

export interface SelfRestartOptions {
  pid?: number
  now?: () => number
  /** Defaults to process.exit; injected in tests. */
  exit?: (code: number) => void
  /** Upper bound on drain work before we exit anyway. */
  drainTimeoutMs?: number
}

export function detectSupervisor(): LifecycleStatus['supervisor'] {
  const env = process.env
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return 'systemd'
  if (env.container || env.DOCKER_CONTAINER_ID || env.KUBERNETES_SERVICE_HOST) return 'docker'
  if (env.pm_id !== undefined) return 'pm2'
  return 'unknown'
}

export function createSelfRestartController(options: SelfRestartOptions = {}): LifecycleController {
  const now = options.now ?? Date.now
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const drainTimeoutMs = options.drainTimeoutMs ?? 5_000
  const startedAt = now()
  const pid = options.pid ?? process.pid
  let state: LifecycleState = 'running'
  const listeners = new Set<() => Promise<void> | void>()

  return {
    status: () => ({ state, pid, startedAt, supervisor: detectSupervisor() }),

    onDrain(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    requestRestart(reason) {
      // Idempotent: a second request during draining is a no-op, not a second exit.
      if (state !== 'running') return
      state = 'draining'

      const drain = Promise.allSettled([...listeners].map((fn) => fn()))
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref?.())
      void Promise.race([drain, timeout]).then(() => {
        state = 'offline'
        console.info(`[mesh] restarting (${reason}); supervisor=${detectSupervisor()}`)
        exit(0)
      })
    },
  }
}
