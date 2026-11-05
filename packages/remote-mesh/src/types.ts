/** Core vocabulary for workspace federation. Kept framework-free so it can be unit-tested alone. */

/** A machine running a DSH host. */
export interface NodeDescriptor {
  nodeId: string
  label: string
  endpoint: string
  online: boolean
  lastSeenAt: number
  workspaces: WorkspaceSummary[]
}

/** Metadata only — never file contents. */
export interface WorkspaceSummary {
  workspaceId: string
  name: string
  path: string
  sessions: SessionSummary[]
}

export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: number
  busy: boolean
}

export type TaskState = 'queued' | 'dispatched' | 'running' | 'done' | 'failed' | 'expired'

export interface TaskPolicy {
  sessionMode: 'new' | 'resume'
  sessionId?: string
  maxDurationMs?: number
  replyMode: 'final' | 'stream'
}

export interface Lease {
  owner: string
  fencingToken: number
  expiresAt: number
}

/** A unit of work bound to exactly one workspace on exactly one node. */
export interface Task {
  taskId: string
  target: { nodeId: string; workspaceId: string }
  objective: string
  context?: string
  acceptance?: string[]
  policy: TaskPolicy
  lease: Lease
  state: TaskState
  createdAt: number
  updatedAt: number
  result?: TaskResult
  error?: string
}

export interface TaskResult {
  summary: string
  sessionId?: string
  artifacts?: string[]
}

/** What a node broadcasts on connect (SPEC §5.4 / §6.1). Capabilities, never contents. */
export interface BundleInfo {
  name: string
  version: string
  enabled: boolean
  error?: string
}

export interface NodeCapabilities {
  workspaces: WorkspaceSummary[]
  bundles: BundleInfo[]
  presets: string[]
  models: string[]
}

export interface NodeLoad {
  cpu: number
  memUsedRatio: number
  tasksInFlight: number
}

export interface NodeLifecycleInfo {
  supervisor: 'systemd' | 'docker' | 'pm2' | 'unknown'
  pid: number
  startedAt: number
}

export interface NodeManifest {
  nodeId: string
  label: string
  dshVersion: string
  capabilities: NodeCapabilities
  load: NodeLoad
  lifecycle: NodeLifecycleInfo
}

/** Optional human overrides on top of the derived registry (SPEC §5.4). */
export interface RegistryOverride {
  workspaceId?: string
  nodeId?: string
  share?: boolean
  pinNode?: string
  acceptFrom?: string[]
}

/** Service tiers (SPEC §16.1). T4 is off by default and needs explicit acknowledgement. */
export type ServiceTier = 'T1' | 'T2' | 'T3' | 'T4'

export interface GrantScope {
  workspaces: string[]
}

export interface Grant {
  grantId: string
  from: string
  to: string
  tiers: ServiceTier[]
  scope: GrantScope
  expiresAt: number
  /** Required for any grant that includes T4. */
  acknowledge?: 'remote-code-execution'
}

/** mesh://<nodeId>/<service>/<method>#<scope> */
export interface MeshAddress {
  nodeId: string
  service: string
  method: string
  scope?: string
}

export type MeshErrorCode =
  | 'denied'
  | 'grant-expired'
  | 'node-offline'
  | 'scope-violation'
  | 'tier-not-granted'
  | 'timeout'
  | 'remote-failure'

export interface MeshError {
  code: MeshErrorCode
  message: string
  grantId?: string
}
