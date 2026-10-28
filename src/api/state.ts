import type { MeshToolRuntime, TransportReport } from '../tools/types.js'
import { PLUGIN_NAME, transportReport } from '../tools/types.js'
import { deriveRoster, wirePeer } from '../roster/index.js'
import type { Task, TaskState } from '../types.js'

/**
 * Snapshot served to the browser settings page. Deliberately metadata only:
 * ids, states, timestamps and the lifecycle/board counters the host already
 * keeps. No task objectives beyond a short preview, no session log, no file
 * contents.
 */

export const MESH_STATE_VERSION = 1
/** Newest tasks kept in the payload; the board itself is unbounded. */
export const MAX_TASK_ROWS = 25
/** Longest objective preview rendered in the task table. */
export const MAX_OBJECTIVE_PREVIEW = 160

const TASK_STATES: readonly TaskState[] = ['queued', 'dispatched', 'running', 'done', 'failed', 'expired']

export interface MeshStateTaskView {
  taskId: string
  state: TaskState
  nodeId: string
  workspaceId: string
  objective: string
  createdAt: number
  updatedAt: number
  leaseOwner: string
  leaseExpiresAt: number
  error?: string
}

export interface MeshStateAssignmentView {
  configured: boolean
  file: string
  nodes: number
  assignments: number
}

export interface MeshStateConfigView {
  transportMode: string
  peerBaseUrl: string
  assignmentFile: string
  leaseMs: number
  dispatchTimeoutMs: number
  leaseOwner: string
}

/** Values buildMeshState cannot read from the runtime itself. */
export interface MeshStateExtras {
  /** Effective peer base URL (loopback transport). */
  peerBaseUrl?: string
  /** Effective assignment file path. */
  assignmentFile?: string
  /** Where browser-saved overrides live. */
  configFile?: string
}

export interface MeshLifecycleView {
  state: string
  supervisor: string
  pid: number
  startedAt: number
}

export interface MeshStateCounts {
  total: number
  queued: number
  dispatched: number
  running: number
  done: number
  failed: number
  expired: number
}

export interface MeshStatePayload {
  ok: true
  version: number
  plugin: string
  generatedAt: number
  transport: TransportReport
  assignment: MeshStateAssignmentView
  config: MeshStateConfigView
  lifecycle: MeshLifecycleView
  counts: MeshStateCounts
  peers: Record<string, unknown>[]
  tasks: MeshStateTaskView[]
  notes: string[]
  /** Override file the settings page writes; empty when unknown. */
  configFile: string
}

function emptyCounts(): MeshStateCounts {
  return { total: 0, queued: 0, dispatched: 0, running: 0, done: 0, failed: 0, expired: 0 }
}

function countTasks(tasks: readonly Task[]): MeshStateCounts {
  const counts = emptyCounts()
  for (const task of tasks) {
    counts.total += 1
    if (TASK_STATES.includes(task.state)) counts[task.state] += 1
  }
  return counts
}

function taskView(task: Task): MeshStateTaskView {
  const objective =
    task.objective.length > MAX_OBJECTIVE_PREVIEW
      ? `${task.objective.slice(0, MAX_OBJECTIVE_PREVIEW)}…`
      : task.objective
  const view: MeshStateTaskView = {
    taskId: task.taskId,
    state: task.state,
    nodeId: task.target.nodeId,
    workspaceId: task.target.workspaceId,
    objective,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    leaseOwner: task.lease.owner,
    leaseExpiresAt: task.lease.expiresAt,
  }
  if (task.error !== undefined && task.error !== '') view.error = task.error
  return view
}

/** Newest tasks first, capped at MAX_TASK_ROWS. */
export function recentTasks(tasks: readonly Task[], limit = MAX_TASK_ROWS): Task[] {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
}

/**
 * Build the settings-page payload. Pure read: it never mutates the board,
 * never dispatches, and degrades to notes when the transport is unavailable.
 */
export async function buildMeshState(
  runtime: MeshToolRuntime,
  now: () => number = Date.now,
  extras: MeshStateExtras = {},
): Promise<MeshStatePayload> {
  const roster = await deriveRoster(runtime)
  const tasks = runtime.board.list()
  const lifecycle = runtime.lifecycle.status()

  return {
    ok: true,
    version: MESH_STATE_VERSION,
    plugin: PLUGIN_NAME,
    generatedAt: now(),
    transport: transportReport(runtime),
    assignment: {
      configured: runtime.assignment !== undefined,
      file: runtime.assignment?.file ?? '',
      nodes: runtime.assignment?.nodes.length ?? 0,
      assignments: runtime.assignment?.assignments.length ?? 0,
    },
    config: {
      transportMode: runtime.config.transportMode,
      peerBaseUrl: extras.peerBaseUrl ?? '',
      assignmentFile: extras.assignmentFile ?? '',
      leaseMs: runtime.config.leaseMs,
      dispatchTimeoutMs: runtime.config.dispatchTimeoutMs,
      leaseOwner: runtime.config.leaseOwner,
    },
    lifecycle: {
      state: lifecycle.state,
      supervisor: lifecycle.supervisor,
      pid: lifecycle.pid,
      startedAt: lifecycle.startedAt,
    },
    counts: countTasks(tasks),
    peers: roster.peers.map(wirePeer),
    tasks: recentTasks(tasks).map(taskView),
    notes: roster.notes,
    configFile: extras.configFile ?? '',
  }
}
