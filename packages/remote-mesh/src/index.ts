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
import { registerMeshPairRoutes } from './api/pair.js'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { handleHubOperatorEvict, MESH_HUB_ADMIN_EVICT_PATH, registerMeshHubRoutes } from './api/hub.js'
import { NonceCache } from './api/mesh-auth.js'
import { mountExactRoute, withConnection } from './api/mount.js'
import { registerMeshHubLinkRoutes } from './api/hub-link.js'
import { handleHandshake, meshHandshakeControl, MESH_HANDSHAKE_PATH } from './api/handshake.js'
import { HubRegistry } from './hub/registry.js'
import { hubStatus } from './hub/status.js'
import { createIdentity, loadOrCreateKeyPair } from './hub/identity.js'
import { HubAgent } from './hub/agent.js'
import { registerMeshRemoteRoute } from './api/remote.js'
import { registerMeshHandshakeRoute } from './api/handshake.js'
import { handleRelay, MESH_RELAY_PATH, meshRelayControl, registerMeshRelayRoute, registerMeshRelayStreamRoute } from './api/relay.js'
import { buildWorkspacesPayload, readWorkspaceRegistry } from './api/workspaces.js'
import { meshConfigPath, readConfigOverride, writeConfigOverride } from './config/store.js'
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
  /** Address other machines should use to reach this one; empty = detect. */
  publicUrl?: string
  /** Join this hub: it keeps the directory and relays to nodes without inbound ports. */
  hub?: { url: string, nodeId?: string, adminSecret?: string, admins?: string[] }
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
    ...(override.publicUrl !== undefined ? { publicUrl: override.publicUrl } : {}),
    ...(override.hub !== undefined ? { hub: override.hub } : {}),
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

  /**
   * Build the transport from the current config.
   *
   * Pairing adds a peer while the process runs, so this is called again after a
   * pair: everything downstream reads `runtime.transport`, never a captured
   * variable, which is what makes the swap take effect without a restart.
   */
  /** This node's name in a hub directory: config, else the dialable address, else the hostname. */
  const meshNodeId = (): string => {
    if (config.hub?.nodeId !== undefined && config.hub.nodeId !== '') return config.hub.nodeId
    if (config.publicUrl !== undefined && config.publicUrl !== '') return new URL(config.publicUrl).host
    const machine = hostname()
    return /^[0-9a-f]{12,}$/i.test(machine) ? 'node' : machine
  }

  /** This node's key pair: generated on first use, never leaves the machine. */
  const identityKeyFile = join(dirname(overrideFile), 'mesh-node-key.json')
  let nodeIdentity: ReturnType<typeof createIdentity> | undefined
  const identityFor = (nodeId: string): ReturnType<typeof createIdentity> => {
    if (nodeIdentity === undefined) nodeIdentity = createIdentity(loadOrCreateKeyPair(identityKeyFile))
    return nodeIdentity
  }

  const buildTransport = (): void => {
    const peers = config.peers ?? []
    if (peers.length === 0) {
      transport = undefined
      transportError = 'no peers configured; add peers to the mesh config (docs/reference/config.md §2)'
      return
    }
    transport = createTypertTransport({
      peers,
      listAssigned: (nodeId) =>
        (assignment?.assignments ?? [])
          .filter((route) => route.nodeId === nodeId && typeof route.cwd === 'string' && route.cwd !== '')
          .map((route) => ({ workspaceId: route.workspaceId, cwd: route.cwd as string })),
      ...(config.meshSecret === undefined || config.meshSecret === '' ? {} : { meshSecret: config.meshSecret }),
      ...(config.hub === undefined || config.hub.url === '' ? {} : { hubUrl: config.hub.url }),
      // Signed hub calls: the hub pins this key on join, so "who is calling" is
      // proved rather than claimed.
      ...(config.meshSecret === undefined || config.meshSecret === ''
        ? {}
        : {
          hubIdentity: {
            nodeId: meshNodeId(),
            headers: (input: { nodeId: string, method: string, path: string, body?: string }) =>
              identityFor(input.nodeId).headers(input),
          },
        }),
      resolveWorkspace: (workspaceId) => {
        const route = assignment?.assignments.find((item) => item.workspaceId === workspaceId)
        if (route?.cwd === undefined || route.cwd === '') return undefined
        return { nodeId: route.nodeId, cwd: route.cwd }
      },
    })
    transportError = undefined
  }
  buildTransport()

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
  const toolRuntime: MeshToolRuntime = {
    board,
    transport,
    transportError,
    assignment,
    lifecycle,
    config: toolConfig,
    hubStatus: () => hubStatusView(),
    // Peer mutations (pairing) re-read the override file and rebuild the
    // transport in place: the routes and tools all read this object.
    reload: () => {
      const next = readConfigOverride(overrideFile)
      config.peers = next.peers ?? config.peers
      if (next.meshSecret !== undefined) config.meshSecret = next.meshSecret
      if (next.publicUrl !== undefined) config.publicUrl = next.publicUrl
      buildTransport()
      toolRuntime.transport = transport
      toolRuntime.transportError = transportError
    },
  }

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
  // Pairing: hand out a link that carries this node's URL and secret, and import
  // one from the other machine. Importing rebuilds the transport in place.
  registerMeshPairRoutes(ctx, {
    runtime: toolRuntime,
    file: overrideFile,
    peers: () => config.peers ?? [],
    publicUrl: () => config.publicUrl ?? '',
    secret: () => config.meshSecret ?? '',
    setSecret: (secret: string) => {
      config.meshSecret = secret
      writeConfigOverride({ meshSecret: secret }, overrideFile)
    },
  })
  // Hub: one public machine that keeps the directory and buffers requests for
  // nodes with no inbound port. The routes are cheap and harmless on a node that
  // is not a hub (nobody joins it), so they are always mounted.
  // The directory survives a restart (so members need not re-join); queues do not.
  const hubRegistry = new HubRegistry(Date.now, join(dirname(overrideFile), 'mesh-hub.json'))
  // Peers the operator configured by hand. A directory update must not delete
  // them: joining a hub adds nodes, it does not take the list over.
  const manualPeers = [...(config.peers ?? [])]
  {
    const hubSecret = () => config.meshSecret ?? ''
    registerMeshHubRoutes(ctx, {
      secret: hubSecret,
      registry: hubRegistry,
      adminSecret: () => config.hub?.adminSecret ?? '',
      admins: () => config.hub?.admins ?? [],
      nonces: new NonceCache(),
    })
    // The operator's own browser evicts through the fence: its session is the
    // credential, so the page never holds the admin secret.
    withConnection(ctx, (inner) => {
      mountExactRoute(inner, {
        path: MESH_HUB_ADMIN_EVICT_PATH,
        methods: ['POST'],
        fetch: (request) => handleHubOperatorEvict(request, {
          secret: hubSecret,
          registry: hubRegistry,
          adminSecret: () => config.hub?.adminSecret ?? '',
          admins: () => config.hub?.admins ?? [],
        }),
      })
      return true
    })
  }

  // Self-healing peer credential: handshake mints a short-lived mesh token, the
  // relay executes session operations locally. Neither touches the login token.
  const meshSecret = () => config.meshSecret ?? ''
  // Mounted unconditionally: pairing can mint this node's first secret while it
  // runs, and a route that was never registered cannot start answering later.
  // With an empty secret each handler refuses with 503 and says why.
  const handshakeControl = meshHandshakeControl(meshSecret)
  {
    registerMeshHandshakeRoute(ctx, meshSecret, handshakeControl)
    registerMeshRelayRoute(
      ctx,
      ctx,
      meshSecret,
      () => buildWorkspacesPayload(readWorkspaceRegistry(ctx)),
      () => readWorkspaceRegistry(ctx),
      () => liveHub,
    )
    // The same mesh token, one open response: a caller reads the peer's live
    // frames as they happen instead of polling for them.
    registerMeshRelayStreamRoute(ctx, meshSecret, () => liveHub)
    console.info('[mesh] peer handshake + relay mounted')
  }

  // What a hub delivery can run on this node. Only the relay surface: it is
  // already token-authenticated per call, so a relayed request cannot do more
  // than a peer could do directly.
  const relayControl = meshRelayControl(
    ctx,
    meshSecret,
    () => buildWorkspacesPayload(readWorkspaceRegistry(ctx)),
    () => readWorkspaceRegistry(ctx),
    () => liveHub,
  )
  const localDispatch = async (delivery: { method: string; path: string; headers: Readonly<Record<string, string>>; body?: string }): Promise<Response> => {
    if (delivery.path !== MESH_RELAY_PATH && delivery.path !== MESH_HANDSHAKE_PATH) {
      return new Response(JSON.stringify({ ok: false, error: 'this node does not serve ' + delivery.path + ' through the hub' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const request = new Request('http://mesh.local' + delivery.path, {
      method: delivery.method,
      headers: { ...delivery.headers, 'content-type': 'application/json' },
      ...(delivery.body === undefined ? {} : { body: Buffer.from(delivery.body, 'base64') }),
    })
    if (delivery.path === MESH_HANDSHAKE_PATH) return await handleHandshake(request, handshakeControl)
    return await handleRelay(request, relayControl)
  }

  let hubAgent: HubAgent | undefined
  /** The hub view the tools and the page read; roles come from the config. */
  const hubStatusView = () => hubStatus({
    url: config.hub?.url ?? '',
    nodeId: config.hub?.nodeId ?? '',
    registry: hubRegistry,
    lastError: hubAgent?.lastError ?? '',
  })
  /**
   * Join the configured hub (idempotent). Called at apply and again when a join
   * link is adopted at runtime, so adopting does not need a restart.
   */

  const startHubAgent = (): void => {
    if (hubAgent !== undefined) return
    if (config.hub === undefined || config.hub.url === '') return
    const hubUrl = config.hub.url
    // Name in the directory: what the operator set, else the address others dial,
    // else the hostname when it is a real name (a container id is a hex blob).
    const machine = hostname()
    const derived = config.publicUrl !== undefined && config.publicUrl !== ''
      ? new URL(config.publicUrl).host
      : (/^[0-9a-f]{12,}$/i.test(machine) ? '' : machine)
    const hubNodeId = config.hub.nodeId !== undefined && config.hub.nodeId !== ''
      ? config.hub.nodeId
      : (derived === '' ? 'node' : derived)
    const nodeId = hubNodeId === '' ? 'node' : hubNodeId
    const agent = new HubAgent({
      hubUrl,
      nodeId,
      // Signed requests: the hub pins this key on first join and can then tell
      // one node from another instead of trusting a self-filled claim.
      identity: identityFor(nodeId),
      publicUrl: () => config.publicUrl ?? '',
      secret: () => config.meshSecret ?? '',
      dispatch: async (delivery) => {
        const response = await localDispatch(delivery)
        const body = Buffer.from(await response.arrayBuffer()).toString('base64')
        return { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body }
      },
      onDirectory: (nodes) => {
        // Everyone the hub knows becomes a peer here: direct ones get their URL,
        // relay-only ones keep an empty baseUrl until the relay path lands.
        const secret = config.meshSecret ?? ''
        const fromHub = nodes
          .filter(node => node.nodeId !== hubNodeId)
          .map(node => ({
            nodeId: node.nodeId,
            baseUrl: node.url,
            // Behind a hub every node keeps the hub as its fallback: an address
            // that answers is used directly (faster, and streaming stays
            // possible), an address that does not falls back to the queue.
            via: 'hub' as const,
            token: '',
            ...(secret === '' ? {} : { secret }),
          }))
        const known = new Set(fromHub.map(peer => peer.nodeId))
        config.peers = [...manualPeers.filter(peer => !known.has(peer.nodeId)), ...fromHub]
        buildTransport()
        toolRuntime.transport = transport
        toolRuntime.transportError = transportError
      },
    })
    hubAgent = agent
    agent.start()
    ctx.effect(() => () => { void agent.stop() }, 'mesh: hub agent')
    console.info('[mesh] joined hub ' + hubUrl + ' as ' + hubNodeId)
  }

  startHubAgent()

  // Domain join: one link from the hub machine, and this node registers there.
  registerMeshHubLinkRoutes(ctx, {
    runtime: toolRuntime,
    file: overrideFile,
    secret: () => config.meshSecret ?? '',
    setSecret: (secret: string) => {
      config.meshSecret = secret
      writeConfigOverride({ meshSecret: secret }, overrideFile)
    },
    publicUrl: () => config.publicUrl ?? '',
    setHub: (hub) => {
      config.hub = hub
      writeConfigOverride({ hub }, overrideFile)
      startHubAgent()
    },
  })

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
export {
  encodeHubPayload,
  decodeHubPayload,
  handleHubAdopt,
  handleHubLink,
  HUB_PAYLOAD_VERSION,
  MESH_HUB_ADOPT_PATH,
  MESH_HUB_LINK_PATH,
  registerMeshHubLinkRoutes,
} from './api/hub-link.js'
export {
  handleHubForward,
  handleHubInbox,
  handleHubJoin,
  handleHubNodes,
  handleHubResult,
  MESH_HUB_FORWARD_PATH,
  MESH_HUB_INBOX_PATH,
  MESH_HUB_JOIN_PATH,
  MESH_HUB_NODES_PATH,
  MESH_HUB_RESULT_PATH,
  registerMeshHubRoutes,
} from './api/hub.js'
export { HubRegistry } from './hub/registry.js'
export { hubStatus } from './hub/status.js'
export { HubAgent } from './hub/agent.js'
export { handleHandshake, MESH_HANDSHAKE_PATH, registerMeshHandshakeRoute } from './api/handshake.js'
export {
  handleRelay,
  handleRelayStream,
  meshRelayControl,
  MESH_RELAY_PATH,
  MESH_RELAY_STREAM_PATH,
  readSessionController,
  registerMeshRelayRoute,
  registerMeshRelayStreamRoute,
} from './api/relay.js'
export { sseResponse } from './api/sse.js'
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