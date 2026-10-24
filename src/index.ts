import type { Context } from '@deepseek-ai/cordis'
import { createInMemoryBoard } from './board/index.js'
import type { TaskBoard } from './board/index.js'
import { detectPairingService, createPairingTransport } from './transport/pairing.js'
import { createLoopbackTransport } from './transport/loopback.js'
import { TransportUnavailableError } from './transport/types.js'
import type { MeshTransport } from './transport/types.js'
import { createSelfRestartController } from './lifecycle/index.js'
import type { LifecycleController } from './lifecycle/index.js'

export const name = 'swarm'

export interface MeshConfig {
  /** auto = pairing when detected, otherwise loopback when baseUrl is set. */
  transport?: 'auto' | 'pairing' | 'loopback'
  /** Peer base URL used by the loopback transport. */
  peerBaseUrl?: string
  /** Assignment table path (see SPEC §5.4). */
  assignmentFile?: string
  /** Default lease TTL for a dispatched task. */
  leaseMs?: number
}

export interface MeshRuntime {
  lifecycle: LifecycleController
  transport?: MeshTransport
  board: TaskBoard
  config: Required<Pick<MeshConfig, 'transport' | 'leaseMs'>> & MeshConfig
}

function pickTransport(ctx: Context, config: MeshConfig): MeshTransport | undefined {
  const mode = config.transport ?? 'auto'
  if (mode === 'pairing' || mode === 'auto') {
    if (detectPairingService(ctx)) return createPairingTransport()
    if (mode === 'pairing') {
      throw new TransportUnavailableError('transport=pairing but remoteWebUiPairing was not found')
    }
  }
  if (config.peerBaseUrl) return createLoopbackTransport(config.peerBaseUrl)
  return undefined
}

export function apply(ctx: Context, rawConfig: MeshConfig = {}): void {
  const config = { transport: rawConfig.transport ?? 'auto', leaseMs: rawConfig.leaseMs ?? 15 * 60_000, ...rawConfig }
  const board = createInMemoryBoard()

  let transport: MeshTransport | undefined
  try {
    transport = pickTransport(ctx, config)
  } catch (err) {
    // Dependency absence is a degradation, never a startup failure (SPEC §9.4.2).
    console.warn('[swarm] transport unavailable:', (err as Error).message)
  }

  // Lifecycle is opt-in (SPEC §14.5): the controller exists, but nothing calls
  // requestRestart unless the lifecycle role is enabled and confirmed.
  const lifecycle: LifecycleController = createSelfRestartController()
  const runtime: MeshRuntime = { transport, board, config, lifecycle }

  if (!transport) {
    console.info('[swarm] loaded without a transport: swarm_* tools will report "no transport configured"')
  }

  // TODO(P2): register swarm_* tools once the tool API is confirmed against
  // the official docs (docs/user/develop/basic/config.md).
  ctx.effect(() => () => {
    void runtime
    console.info('[swarm] disposed')
  })
}

export type { NodeDescriptor, WorkspaceSummary, Task, TaskState } from './types.js'
export type { MeshTransport } from './transport/types.js'
export { createSelfRestartController, detectSupervisor } from './lifecycle/index.js'
export type { LifecycleController, LifecycleStatus } from './lifecycle/index.js'
