import type { Context } from '@deepseek-ai/cordis'
import { loadAssignmentTable } from './assignments/index.js'
import type { AssignmentTable } from './assignments/index.js'
import { createInMemoryBoard } from './board/index.js'
import type { TaskBoard } from './board/index.js'
import { createSelfRestartController } from './lifecycle/index.js'
import type { LifecycleController } from './lifecycle/index.js'
import { createTypertTransport } from './transport/typert.js'
import type { MeshPeerConfig } from './config.js'
import type { MeshTransport } from './transport/types.js'
import { registerMeshStateRoute } from './api/index.js'
import { registerMeshConfigRoute } from './api/config.js'
import { registerMeshDispatchRoute } from './api/dispatch.js'
import { registerMeshWorkspacesRoute } from './api/workspaces.js'
import { registerMeshSessionPageRoutes, registerMeshSessionRoute } from './api/session.js'
import { AssistantLiveHub } from './live/assistant.js'
import { registerMeshRemoteRoute } from './api/remote.js'
import { registerMeshHandshakeRoute } from './api/handshake.js'
import { registerMeshRelayRoute } from './api/relay.js'
import { buildWorkspacesPayload, readWorkspaceRegistry } from './api/workspaces.js'
import { meshConfigPath, readConfigOverride } from './config/store.js'
import { PLUGIN_NAME, registerMeshTools } from './tools/index.js'
import type { MeshToolConfig, MeshToolRegistry, MeshToolRuntime } from './tools/index.js'
import { readLive } from './config.js'

/** Cordis registration name; mesh_status reports the same string (F-10). */
export const name = PLUGIN_NAME

/**
 * `tools` is required (without it cordis never injects the tool runtime, spike §2.1);
 * `webServer` is optional — the peer handshake/relay routes need a raw HTTP seat
 * below the browser fence, and a headless composition simply does not have one.
 */
// cordis reads this as a service map: a nullable value means optional.
export const inject = { tools: true, webServer: null }

export interface MeshConfig {
  /** Reserved for transport selection; 'auto' is the only value until an adapter ships. */
  transport?: 'auto'
  /** Peers reachable over their web API; empty = no cross-machine transport. */
  peers?: MeshPeerConfig[]
  /** Shared secret for peer handshakes; enables relay mode (no login token needed). */
  meshSecret?: string
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
  transport: 'auto'
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

export function apply(ctx: Context, rawConfig: MeshConfig = {}): void {
  // Fields are schema-volatile: the loader hands them over as live references.
  const entryConfig: ResolvedMeshConfig = {
    ...rawConfig,
    transport: readLive(rawConfig.transport, 'auto'),
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
    ...(override.peers !== undefined ? { peers: override.peers } : {}),
    ...(override.meshSecret !== undefined ? { meshSecret: override.meshSecret } : {}),
    ...(override.leaseMs !== undefined ? { leaseMs: override.leaseMs } : {}),
    ...(override.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: override.dispatchTimeoutMs } : {}),
    ...(override.leaseOwner !== undefined ? { leaseOwner: override.leaseOwner } : {}),
  }
  const board = createInMemoryBoard()

  // Cross-machine transport is opt-in: it needs at least one configured peer.
  // A missing transport is a degradation, never a startup failure (SPEC §9.4.2):
  // the plugin loads and the tools report `unavailable` with this reason.
  let transport: MeshTransport | undefined
  let transportError: string | undefined

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

  const peers = config.peers ?? []
  if (peers.length > 0) {
    transport = createTypertTransport({
      peers,
      listAssigned: (nodeId) =>
        (assignment?.assignments ?? [])
          .filter((route) => route.nodeId === nodeId && typeof route.cwd === 'string' && route.cwd !== '')
          .map((route) => ({ workspaceId: route.workspaceId, cwd: route.cwd as string })),
      ...(config.meshSecret === undefined || config.meshSecret === '' ? {} : { meshSecret: config.meshSecret }),
      resolveWorkspace: (workspaceId) => {
        const route = assignment?.assignments.find((item) => item.workspaceId === workspaceId)
        if (route?.cwd === undefined || route.cwd === '') return undefined
        return { nodeId: route.nodeId, cwd: route.cwd }
      },
    })
  } else {
    transportError = 'no peers configured; add peers to the mesh config (docs/reference/config.md §2)'
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
    assignmentFile: toolRuntime.assignment?.file ?? '',
    configFile: overrideFile,
  })
  registerMeshStateRoute(ctx, toolRuntime, stateExtras)
  registerMeshConfigRoute(ctx, { runtime: toolRuntime, file: overrideFile, extras: stateExtras })
  registerMeshDispatchRoute(ctx, toolRuntime)
  // Peers list this node's native workspaces; nothing is created or mutated here.
  registerMeshWorkspacesRoute(ctx, ctx)
  registerMeshSessionRoute(ctx, toolRuntime)
  // This Host's own live Assistant frames, retained so a page on another machine
  // can paint an answer while it is being written instead of when it lands.
  const liveHub = new AssistantLiveHub(ctx)
  ctx.effect(() => () => { liveHub.release() }, 'mesh: assistant live frames')
  registerMeshSessionPageRoutes(ctx, toolRuntime, liveHub)
  // Peer administration for the sidebar's remote section: browse a peer's
  // directories, and let it register a Workspace there.
  registerMeshRemoteRoute(ctx, toolRuntime)
  // Self-healing peer credential: handshake mints a short-lived mesh token, the
  // relay executes session operations locally. Neither touches the login token.
  const meshSecret = () => config.meshSecret ?? ''
  const peerRoutes = meshSecret() !== ''
  if (peerRoutes) {
    registerMeshHandshakeRoute(ctx, meshSecret)
    registerMeshRelayRoute(
      ctx,
      ctx,
      meshSecret,
      () => buildWorkspacesPayload(readWorkspaceRegistry(ctx)),
      () => readWorkspaceRegistry(ctx),
      () => liveHub,
    )
    console.info('[mesh] peer handshake + relay mounted (meshSecret configured)')
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
export { buildMeshState, MESH_STATE_VERSION, MAX_TASK_ROWS, recentTasks } from './api/state.js'
export type { MeshStateCounts, MeshStatePayload, MeshStateTaskView } from './api/state.js'
export { MESH_STATE_PATH, registerMeshStateRoute } from './api/index.js'
export { handleConfigSave, HOT_CONFIG_KEYS, MESH_CONFIG_PATH, registerMeshConfigRoute, RESTART_CONFIG_KEYS } from './api/config.js'
export { handleDispatch, MESH_DISPATCH_PATH, registerMeshDispatchRoute } from './api/dispatch.js'
export { buildWorkspacesPayload, MESH_WORKSPACES_PATH, readWorkspaceRegistry, registerMeshWorkspacesRoute } from './api/workspaces.js'
export {
  handleSessionEvents,
  handleSessionOpen,
  handleSessionPrompt,
  handleSessionRead,
  MESH_SESSION_EVENTS_PATH,
  MESH_SESSION_OPEN_PATH,
  MESH_SESSION_PATH,
  MESH_SESSION_PROMPT_PATH,
  registerMeshSessionPageRoutes,
  registerMeshSessionRoute,
} from './api/session.js'
export { handleRemote, MESH_REMOTE_PATH, mountMeshRemoteRoute, registerMeshRemoteRoute } from './api/remote.js'
export { handleHandshake, MESH_HANDSHAKE_PATH, registerMeshHandshakeRoute } from './api/handshake.js'
export { handleRelay, MESH_RELAY_PATH, readSessionController, registerMeshRelayRoute } from './api/relay.js'
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