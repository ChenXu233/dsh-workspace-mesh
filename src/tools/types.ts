import type { AssignmentTable } from '../assignments/index.js'
import type { TaskBoard } from '../board/index.js'
import type { LifecycleController } from '../lifecycle/index.js'
import type { MeshTransport } from '../transport/types.js'
import type { MeshErrorCode, WorkspaceSummary } from '../types.js'

/**
 * Framework-free tool surface (spike §5, plan A): a definition is a plain object
 * with a raw JSON Schema `parameters`, a validated `output { schema, render }`
 * and an `execute`. `ctx.tools.register(definition)` is the only host API used;
 * the DSH tool package itself is never imported (it is not resolvable from a profile).
 */

export interface MeshToolContentBlock {
  type: 'text'
  text: string
}

export interface MeshToolExec {
  /** Aborts when the host cancels the tool call. */
  signal?: AbortSignal
  agent?: unknown
}

export interface MeshToolDefinition {
  name: string
  description: string
  /** Raw JSON Schema, projected to the model unchanged (spike §2.3). */
  parameters: Record<string, unknown>
  output: {
    /** Must stay inside the supported JSON Schema subset (assertSupportedJsonSchema). */
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => MeshToolContentBlock[]
  }
  execute: (args: unknown, exec: MeshToolExec) => unknown | Promise<unknown>
  timeoutMs?: number
}

export interface MeshToolRegistry {
  register(definition: MeshToolDefinition): unknown
}

export interface MeshToolHost {
  tools: MeshToolRegistry
}

export interface MeshToolConfig {
  transportMode: 'auto' | 'pairing' | 'loopback'
  leaseMs: number
  leaseOwner: string
  dispatchTimeoutMs: number
}

/** Everything the tools need; assembled once by apply() (and by tests). */
export interface MeshToolRuntime {
  board: TaskBoard
  transport?: MeshTransport
  /** Why transport selection degraded, when it did. */
  transportError?: string
  assignment?: AssignmentTable
  lifecycle: LifecycleController
  config: MeshToolConfig
  now?: () => number
  newTaskId?: () => string
}

/** Cordis registration name; mesh_status reports the same string. */
export const PLUGIN_NAME = 'dsh-workspace-mesh'

/**
 * Tool-layer error vocabulary: SPEC §16 MeshErrorCode plus the local/target
 * distinctions the tool face needs. src/types.ts is out of scope for t8, so the
 * superset stays here; the model-facing schema enumerates this set.
 */
export type MeshToolErrorCode = MeshErrorCode | 'unavailable' | 'unknown-node' | 'invalid-target'

export interface MeshToolError {
  code: MeshToolErrorCode
  message: string
  /** Original error name/message/stack, retained for diagnosis (F-5). */
  cause?: string
}

export const MESH_ERROR_CODE_VALUES: readonly MeshToolErrorCode[] = [
  'denied',
  'grant-expired',
  'node-offline',
  'scope-violation',
  'tier-not-granted',
  'timeout',
  'remote-failure',
  'unavailable',
  'unknown-node',
  'invalid-target',
]

/** Shared transport report for mesh_status / mesh_list_nodes. */
export const TRANSPORT_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: { type: 'boolean', description: 'Whether a MeshTransport implementation is active.' },
    mode: { type: 'string', description: 'Configured transport selection: auto | pairing | loopback.' },
    kind: { type: 'string', description: 'Active transport kind (pairing | loopback | mock), empty when none.' },
    reason: { type: 'string', description: 'Why no transport is active; empty when configured.' },
  },
  required: ['configured', 'mode', 'kind', 'reason'],
}

export const WORKSPACE_VIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string' },
    sessions: { type: 'integer', description: 'Number of sessions in the workspace (metadata only).' },
  },
  required: ['workspaceId', 'name', 'path', 'sessions'],
}

export interface TransportReport {
  configured: boolean
  mode: string
  kind: string
  reason: string
}

export function transportReport(runtime: MeshToolRuntime): TransportReport {
  if (runtime.transport !== undefined) {
    return { configured: true, mode: runtime.config.transportMode, kind: runtime.transport.kind, reason: '' }
  }
  const reason =
    runtime.transportError === undefined || runtime.transportError === ''
      ? 'no transport configured'
      : `no transport configured (${runtime.transportError})`
  return { configured: false, mode: runtime.config.transportMode, kind: '', reason }
}

export function workspaceViews(workspaces: readonly WorkspaceSummary[]): Array<{
  workspaceId: string
  name: string
  path: string
  sessions: number
}> {
  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: workspace.path,
    sessions: workspace.sessions.length,
  }))
}

/** Render the canonical value as JSON text; malformed values still render something readable. */
export function renderJson(_args: unknown, value: unknown): MeshToolContentBlock[] {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text }]
}

export function asArgsRecord(args: unknown, toolName: string): Record<string, unknown> {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object`)
  }
  return args as Record<string, unknown>
}

export function rejectUnknownArgs(
  record: Record<string, unknown>,
  known: readonly string[],
  toolName: string,
): void {
  const allowed = new Set(known)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${toolName}: unknown argument "${key}"`)
  }
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  toolName: string,
  options: { nonEmpty?: boolean } = {},
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${toolName}: "${key}" must be a string`)
  if (options.nonEmpty === true && value.trim() === '') {
    throw new Error(`${toolName}: "${key}" must be a non-empty string`)
  }
  return value
}

export function requiredString(record: Record<string, unknown>, key: string, toolName: string): string {
  const value = optionalString(record, key, toolName, { nonEmpty: true })
  if (value === undefined) throw new Error(`${toolName}: "${key}" is required`)
  return value
}
