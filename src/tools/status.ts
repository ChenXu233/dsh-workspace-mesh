import type { TaskState } from '../types.js'
import type { MeshToolDefinition, MeshToolRuntime } from './types.js'
import { renderJson, TRANSPORT_REPORT_SCHEMA, transportReport } from './types.js'

const ASSIGNMENT_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: { type: 'boolean', description: 'Whether assignmentFile was configured and parsed.' },
    file: { type: 'string', description: 'Absolute path of the parsed assignment file; empty when none.' },
    nodes: { type: 'integer', description: 'Number of node entries declared in assignment.yml.' },
    assignments: { type: 'integer', description: 'Number of workspace -> node assignments declared.' },
  },
  required: ['configured', 'file', 'nodes', 'assignments'],
}

const BOARD_COUNTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    queued: { type: 'integer' },
    dispatched: { type: 'integer' },
    running: { type: 'integer' },
    done: { type: 'integer' },
    failed: { type: 'integer' },
    expired: { type: 'integer' },
  },
  required: ['total', 'queued', 'dispatched', 'running', 'done', 'failed', 'expired'],
}

const LIFECYCLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', description: 'running | draining | offline' },
    supervisor: { type: 'string', description: 'systemd | docker | pm2 | unknown' },
    pid: { type: 'integer' },
    startedAt: { type: 'number', description: 'Unix milliseconds when the controller was created.' },
  },
  required: ['state', 'supervisor', 'pid', 'startedAt'],
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plugin: { type: 'string' },
    transport: TRANSPORT_REPORT_SCHEMA,
    assignment: ASSIGNMENT_SUMMARY_SCHEMA,
    board: BOARD_COUNTS_SCHEMA,
    lifecycle: LIFECYCLE_SCHEMA,
  },
  required: ['plugin', 'transport', 'assignment', 'board', 'lifecycle'],
}

interface BoardCounts {
  total: number
  queued: number
  dispatched: number
  running: number
  done: number
  failed: number
  expired: number
}

const TASK_STATES: readonly TaskState[] = ['queued', 'dispatched', 'running', 'done', 'failed', 'expired']

function countTasks(runtime: MeshToolRuntime): BoardCounts {
  const counts: BoardCounts = { total: 0, queued: 0, dispatched: 0, running: 0, done: 0, failed: 0, expired: 0 }
  for (const task of runtime.board.list()) {
    counts.total += 1
    if (TASK_STATES.includes(task.state)) counts[task.state] += 1
  }
  return counts
}

/**
 * mesh_status — local health snapshot. This is an EXTRA mesh-level overview
 * outside SPEC §18 (it does not replace mesh_task_status). It never performs a
 * cross-machine call, so it stays useful precisely when no transport is
 * configured (SPEC §9.4.2).
 */
export function createMeshStatusTool(runtime: MeshToolRuntime): MeshToolDefinition {
  return {
    name: 'mesh_status',
    description:
      '报告 workspace mesh 的本地状态：传输是否就绪、assignment.yml 摘要、任务板各状态计数、进程生命周期。这是 SPEC §18 之外的补充总览工具（不替代 mesh_task_status）；不发起跨机调用，没有传输时也能安全调用。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute() {
      const lifecycle = runtime.lifecycle.status()
      return {
        plugin: 'dsh-workspace-mesh',
        transport: transportReport(runtime),
        assignment: {
          configured: runtime.assignment !== undefined,
          file: runtime.assignment?.file ?? '',
          nodes: runtime.assignment?.nodes.length ?? 0,
          assignments: runtime.assignment?.assignments.length ?? 0,
        },
        board: countTasks(runtime),
        lifecycle: {
          state: lifecycle.state,
          supervisor: lifecycle.supervisor,
          pid: lifecycle.pid,
          startedAt: lifecycle.startedAt,
        },
      }
    },
  }
}
