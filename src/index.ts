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
import { registerMeshStateRoute } from './api/index.js'
import { registerMeshConfigRoute } from './api/config.js'
import { meshConfigPath, readConfigOverride } from './config/store.js'
import { PLUGIN_NAME, registerMeshTools } from './tools/index.js'
import type { MeshToolConfig, MeshToolRegistry, MeshToolRuntime } from './tools/index.js'
import { readLive } from './config.js'

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
  // Fields are schema-volatile: the loader hands them over as live references.
  const entryConfig: ResolvedMeshConfig = {
    ...rawConfig,
    transport: readLive(rawConfig.transport, 'auto'),
    peerBaseUrl: readLive(rawConfig.peerBaseUrl, ''),
    leaseMs: readLive(rawConfig.leaseMs, 15 * 60_000),
    dispatchTimeoutMs: readLive(rawConfig.dispatchTimeoutMs, 120_000),
    leaseOwner: readLive(rawConfig.leaseOwner, 'mesh-lead'),
  }
  // Browser-saved overrides win over the cordis entry config. The native
  // settings document cannot edit a profile-patch mounted entry, so the
  // settings page writes its own file instead.
  const overrideFile = meshConfigPath()
  const override = readConfigOverride(overrideFile)
  const config: ResolvedMeshConfig = {
    ...entryConfig,
    ...(override.transport !== undefined ? { transport: override.transport } : {}),
    ...(override.peerBaseUrl !== undefined ? { peerBaseUrl: override.peerBaseUrl } : {}),
    ...(override.leaseMs !== undefined ? { leaseMs: override.leaseMs } : {}),
    ...(override.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: override.dispatchTimeoutMs } : {}),
    ...(override.leaseOwner !== undefined ? { leaseOwner: override.leaseOwner } : {}),
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
  // The loader may hand the raw entry config through as live references; only
  // a plain string is a real path here — anything else is treated as unset
  // rather than killing the whole entry (a dead fiber hides the settings form).
  const rawAssignment: unknown = rawConfig.assignmentFile
  const entryAssignmentFile =
    typeof rawAssignment === 'string'
      ? rawAssignment
      : rawAssignment !== null && typeof rawAssignment === 'object' && 'get' in (rawAssignment as Record<string, unknown>)
        ? String((rawAssignment as { get(): unknown }).get() ?? '')
        : ''
  const assignmentFile = override.assignmentFile !== undefined ? override.assignmentFile : entryAssignmentFile
  let assignment: AssignmentTable | undefined
  if (assignmentFile !== '') {
    assignment = loadAssignmentTable(assignmentFile)
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

  // One runtime object backs both faces: the model tools and the read-only
  // snapshot the browser settings page polls.
  const toolRuntime: MeshToolRuntime = { board, transport, transportError, assignment, lifecycle, config: toolConfig }

  const tools = (ctx as unknown as { tools?: MeshToolRegistry }).tools
  if (tools === undefined) {
    // The host composition may legitimately mount this plugin without the tools
    // service; mesh_* then cannot exist, but the plugin still loads.
    console.warn('[mesh] tool runtime unavailable: mesh_* tools were not registered')
  } else {
    registerMeshTools({ tools }, toolRuntime)
    console.info('[mesh] registered mesh_list_nodes / mesh_status / mesh_dispatch / mesh_task_status')
  }

  // Settings page surface. Absent in headless compositions (no web server):
  // the page then explains that the route is missing instead of failing silently.
  const stateExtras = () => ({
    peerBaseUrl: config.peerBaseUrl ?? '',
    assignmentFile: toolRuntime.assignment?.file ?? '',
    configFile: overrideFile,
  })
  registerMeshStateRoute(ctx, toolRuntime, stateExtras)
  registerMeshConfigRoute(ctx, { runtime: toolRuntime, file: overrideFile, extras: stateExtras })

  if (!transport) {
    console.info('[mesh] loaded without a transport: mesh_* tools will report "no transport configured"')
  }

  ctx.effect(() => () => {
    void runtime
    console.info('[mesh] disposed')
  })
}

export { Config } from './config.js'
export { buildMeshState, MESH_STATE_VERSION, MAX_TASK_ROWS, recentTasks } from './api/state.js'
export type { MeshStateCounts, MeshStatePayload, MeshStateTaskView } from './api/state.js'
export { MESH_STATE_PATH, registerMeshStateRoute } from './api/index.js'
export { handleConfigSave, HOT_CONFIG_KEYS, MESH_CONFIG_PATH, registerMeshConfigRoute, RESTART_CONFIG_KEYS } from './api/config.js'
export type { MeshConfigControl } from './api/config.js'
export { meshConfigPath, readConfigOverride, sanitizeOverride, writeConfigOverride } from './config/store.js'
export type { MeshConfigOverride } from './config/store.js'
export { deriveRoster, wirePeer } from './roster/index.js'
export type { PeerSource, PeerStatus, PeerView, RosterSnapshot } from './roster/index.js'
export type { Config as MeshConfigSchema } from './config.js'
export { AssignmentFileError, findAssignmentNode, findAssignmentRoute, loadAssignmentTable, parseAssignment } from './assignments/index.js'
export type { AssignmentNode, AssignmentRoute, AssignmentTable } from './assignments/index.js'
export { createTaskId, registerMeshTools } from './tools/index.js'
export type { MeshTransport } from './transport/types.js'
export type { MeshToolConfig, MeshToolDefinition, MeshToolRuntime } from './tools/index.js'
export type { NodeDescriptor, Task, TaskState, WorkspaceSummary } from './types.js'
export { createSelfRestartController, detectSupervisor } from './lifecycle/index.js'
export type { LifecycleController, LifecycleStatus } from './lifecycle/index.js'
