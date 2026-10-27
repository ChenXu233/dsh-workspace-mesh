import type { Context } from '@deepseek-ai/cordis'
import { loadAssignmentTable } from './assignments/index.js'
import type { AssignmentTable } from './assignments/index.js'
import { createInMemoryBoard } from './board/index.js'
import type { TaskBoard } from './board/index.js'
import { createSelfRestartController } from './lifecycle/index.js'
import type { LifecycleController } from './lifecycle/index.js'
import { createLoopbackTransport } from './transport/loopback.js'
import { createPairingTransport, detectPairingService } from './transport/pairing.js'
import { TransportUnavailableError } from './transport/types.js'
import type { MeshTransport } from './transport/types.js'
import { PLUGIN_NAME, registerMeshTools } from './tools/index.js'
import type { MeshToolConfig, MeshToolRegistry } from './tools/index.js'

/** Cordis registration name; mesh_status reports the same string (F-10). */
export const name = PLUGIN_NAME

/** Without this export cordis never injects the tool runtime (spike §2.1). */
export const inject = ['tools']

export interface MeshConfig {
  /** auto = pairing when detected, otherwise loopback when baseUrl is set. */
  transport?: 'auto' | 'pairing' | 'loopback'
  /** Peer base URL used by the loopback transport. */
  peerBaseUrl?: string
  /** Assignment table path (SPEC §5.4), resolved against the host process cwd. */
  assignmentFile?: string
  /** Default lease TTL for a dispatched task. */
  leaseMs?: number
  /** How long mesh_dispatch waits for a final reply before expiring the task. */
  dispatchTimeoutMs?: number
  /** Task board lease owner recorded for dispatches made by these tools. */
  leaseOwner?: string
}

export interface ResolvedMeshConfig extends MeshConfig {
  transport: 'auto' | 'pairing' | 'loopback'
  leaseMs: number
  dispatchTimeoutMs: number
  leaseOwner: string
}

export interface MeshRuntime {
  lifecycle: LifecycleController
  transport?: MeshTransport
  /** Why transport selection degraded; surfaced by mesh_status/mesh_list_nodes. */
  transportError?: string
  board: TaskBoard
  assignment?: AssignmentTable
  config: ResolvedMeshConfig
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
  const config: ResolvedMeshConfig = {
    ...rawConfig,
    transport: rawConfig.transport ?? 'auto',
    leaseMs: rawConfig.leaseMs ?? 15 * 60_000,
    dispatchTimeoutMs: rawConfig.dispatchTimeoutMs ?? 120_000,
    leaseOwner: rawConfig.leaseOwner ?? 'mesh-lead',
  }
  const board = createInMemoryBoard()

  let transport: MeshTransport | undefined
  let transportError: string | undefined
  try {
    transport = pickTransport(ctx, config)
  } catch (err) {
    // Dependency absence is a degradation, never a startup failure (SPEC §9.4.2).
    transportError = (err as Error).message
    console.warn('[mesh] transport unavailable:', transportError)
  }

  // A configured assignment file is configuration, not an optional dependency:
  // a missing or malformed file fails loudly with its path and line (SPEC §8).
  let assignment: AssignmentTable | undefined
  if (config.assignmentFile !== undefined && config.assignmentFile !== '') {
    assignment = loadAssignmentTable(config.assignmentFile)
  }

  // Lifecycle is opt-in (SPEC §14.5): the controller exists, but nothing calls
  // requestRestart unless the lifecycle role is enabled and confirmed.
  const lifecycle: LifecycleController = createSelfRestartController()
  const runtime: MeshRuntime = { transport, transportError, board, assignment, config, lifecycle }

  const toolConfig: MeshToolConfig = {
    transportMode: config.transport,
    leaseMs: config.leaseMs,
    leaseOwner: config.leaseOwner,
    dispatchTimeoutMs: config.dispatchTimeoutMs,
  }

  const tools = (ctx as unknown as { tools?: MeshToolRegistry }).tools
  if (tools === undefined) {
    // The host composition may legitimately mount this plugin without the tools
    // service; mesh_* then cannot exist, but the plugin still loads.
    console.warn('[mesh] tool runtime unavailable: mesh_* tools were not registered')
  } else {
    registerMeshTools(
      { tools },
      { board, transport, transportError, assignment, lifecycle, config: toolConfig },
    )
    console.info('[mesh] registered mesh_list_nodes / mesh_status / mesh_dispatch / mesh_task_status')
  }

  if (!transport) {
    console.info('[mesh] loaded without a transport: mesh_* tools will report "no transport configured"')
  }

  ctx.effect(() => () => {
    void runtime
    console.info('[mesh] disposed')
  })
}

export { Config } from './config.js'
export type { Config as MeshConfigSchema } from './config.js'
export { AssignmentFileError, findAssignmentNode, findAssignmentRoute, loadAssignmentTable, parseAssignment } from './assignments/index.js'
export type { AssignmentNode, AssignmentRoute, AssignmentTable } from './assignments/index.js'
export { createTaskId, registerMeshTools } from './tools/index.js'
export type { MeshTransport } from './transport/types.js'
export type { MeshToolConfig, MeshToolDefinition, MeshToolRuntime } from './tools/index.js'
export type { NodeDescriptor, Task, TaskState, WorkspaceSummary } from './types.js'
export { createSelfRestartController, detectSupervisor } from './lifecycle/index.js'
export type { LifecycleController, LifecycleStatus } from './lifecycle/index.js'
