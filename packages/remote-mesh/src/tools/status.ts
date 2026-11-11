import type { TaskState } from '../types.js'
import type { MeshToolDefinition, MeshToolRuntime } from './types.js'
import { PLUGIN_NAME, renderJson, TRANSPORT_REPORT_SCHEMA, transportReport } from './types.js'

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

const HUB_NODE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: { type: 'string' },
    url: { type: 'string', description: 'Address this node advertised; empty means it is only reachable through the hub.' },
    pending: { type: 'integer', description: 'Requests queued for this node right now.' },
    lastSeenAt: { type: 'number', description: 'Unix milliseconds when this node last polled.' },
    ageMs: { type: 'integer', description: 'Milliseconds since that poll.' },
  },
  required: ['nodeId', 'url', 'pending', 'lastSeenAt', 'ageMs'],
}

const HUB_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['hub', 'member', 'off'], description: 'hub: others join this node; member: this node joined one; off: no hub involved.' },
    url: { type: 'string', description: 'Hub this node joined; empty when it joined none.' },
    nodeId: { type: 'string', description: 'This node id in the hub directory.' },
    nodes: { type: 'array', items: HUB_NODE_SCHEMA },
    pending: { type: 'integer', description: 'Forwarded requests waiting across all nodes.' },
    lastError: { type: 'string', description: 'Why the last join/poll failed; empty when healthy.' },
  },
  required: ['role', 'url', 'nodeId', 'nodes', 'pending', 'lastError'],
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
    hub: HUB_SCHEMA,
  },
  required: ['plugin', 'transport', 'assignment', 'board', 'lifecycle', 'hub'],
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
        plugin: PLUGIN_NAME,
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
        // Absent hub support still answers a shape: 'off' with no nodes.
        hub: runtime.hubStatus?.() ?? { role: 'off', url: '', nodeId: '', nodes: [], pending: 0, lastError: '' },
      }
    },
  }
}