import { createMeshDispatchTool } from './dispatch.js'
import { createMeshListNodesTool } from './list-nodes.js'
import { createMeshStatusTool } from './status.js'
import { createMeshTaskStatusTool } from './task-status.js'
import type { MeshToolDefinition, MeshToolHost, MeshToolRuntime } from './types.js'

export type {
  MeshToolConfig,
  MeshToolContentBlock,
  MeshToolDefinition,
  MeshToolExec,
  MeshToolHost,
  MeshToolRegistry,
  MeshToolRuntime,
} from './types.js'

export { PLUGIN_NAME } from './types.js'
export { createTaskId } from './task-id.js'
export { ReplyCollector } from './protocol.js'

/**
 * SPEC §18 is the external naming contract. P2 implements a subset and records
 * every deviation explicitly:
 * - mesh_list_nodes = SPEC §18 mesh_list_nodes. DSH has no core roster service
 *   (spike p1 §2.3), so the list is derived from assignment.yml plus transport
 *   receipts. Workspaces are embedded per node, which covers
 *   mesh_list_workspaces(nodeId?) without a second tool.
 * - mesh_status is an EXTRA mesh-level overview tool, outside SPEC §18. It does
 *   not replace mesh_task_status.
 * - mesh_dispatch keeps SPEC §18's arguments, but blocks until the final reply
 *   and returns { taskId, state, target, result|error } instead of { taskId }.
 *   The async "taskId + mesh_task_wait" model needs a durable task store and is
 *   deferred to a later increment.
 * - mesh_task_status is implemented on TaskBoard.get() (SPEC §18 name).
 * - Deferred: mesh_task_wait, mesh_cancel, mesh_lifecycle, mesh_plugin_*,
 *   mesh_call, mesh_grants.
 */

/** The P2 tools, in registration order. */
export function createMeshTools(runtime: MeshToolRuntime): MeshToolDefinition[] {
  return [
    createMeshListNodesTool(runtime),
    createMeshStatusTool(runtime),
    createMeshDispatchTool(runtime),
    createMeshTaskStatusTool(runtime),
  ]
}

/**
 * Register the P2 tool surface on the host tool runtime. `register` is itself an
 * effect in DSH, so disposal is automatic; the returned definitions let tests
 * assert exactly what the model will see.
 */
export function registerMeshTools(host: MeshToolHost, runtime: MeshToolRuntime): MeshToolDefinition[] {
  const definitions = createMeshTools(runtime)
  for (const definition of definitions) host.tools.register(definition)
  return definitions
}
