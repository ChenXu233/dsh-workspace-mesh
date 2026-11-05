import type { MeshToolDefinition, MeshToolRuntime } from './types.js'
import { asArgsRecord, renderJson, rejectUnknownArgs, requiredString } from './types.js'

const TASK_STATE_VALUES = ['queued', 'dispatched', 'running', 'done', 'failed', 'expired'] as const

const TARGET_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' },
    workspaceId: { type: 'string' },
  },
  required: ['nodeId', 'workspaceId'],
}

const POLICY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionMode: { type: 'string', enum: ['new', 'resume'] },
    sessionId: { type: 'string' },
    maxDurationMs: { type: 'number' },
    replyMode: { type: 'string', enum: ['final', 'stream'] },
  },
  required: ['sessionMode', 'replyMode'],
}

const LEASE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string' },
    fencingToken: { type: 'integer' },
    expiresAt: { type: 'number' },
  },
  required: ['owner', 'fencingToken', 'expiresAt'],
}

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    sessionId: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary'],
}

/** Mirrors the Task envelope from SPEC §5.3 / §18. */
const TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string' },
    target: TARGET_SCHEMA,
    objective: { type: 'string' },
    context: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
    policy: POLICY_SCHEMA,
    lease: LEASE_SCHEMA,
    state: { type: 'string', enum: [...TASK_STATE_VALUES] },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    result: RESULT_SCHEMA,
    error: { type: 'string' },
  },
  required: ['taskId', 'target', 'objective', 'policy', 'lease', 'state', 'createdAt', 'updatedAt'],
}

/**
 * mesh_task_status — SPEC §18 name, backed directly by TaskBoard.get().
 * The board is in-memory in P2, so only tasks created by this plugin instance
 * are visible; mesh_task_wait (which needs durable storage) is deferred.
 */
export function createMeshTaskStatusTool(runtime: MeshToolRuntime): MeshToolDefinition {
  return {
    name: 'mesh_task_status',
    description:
      '读取任务板上某个 taskId 的当前状态（SPEC §18 的 mesh_task_status）：返回 Task（目标、状态、租约、结果或错误）。P2 的任务板在进程内存中；异步等待（mesh_task_wait）尚未实现。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'mesh_dispatch 返回的 taskId。' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: TASK_SCHEMA,
      render: renderJson,
    },
    async execute(rawArgs) {
      const args = asArgsRecord(rawArgs, 'mesh_task_status')
      rejectUnknownArgs(args, ['taskId'], 'mesh_task_status')
      const taskId = requiredString(args, 'taskId', 'mesh_task_status')
      const task = runtime.board.get(taskId)
      if (task === undefined) {
        throw new Error(`mesh_task_status: task "${taskId}" is not on this host's in-memory board`)
      }
      return task
    },
  }
}
