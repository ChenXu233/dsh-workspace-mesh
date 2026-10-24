import { findAssignmentRoute } from '../assignments/index.js'
import type { LeaseFence } from '../board/index.js'
import type { Task, TaskPolicy, TaskResult } from '../types.js'
import { buildDispatchPrompt, meshErrorFrom, ReplyCollector, toMeshError } from './protocol.js'
import { createTaskId } from './task-id.js'
import type { MeshToolDefinition, MeshToolError, MeshToolErrorCode, MeshToolRuntime } from './types.js'
import { asArgsRecord, MESH_ERROR_CODE_VALUES, optionalString, rejectUnknownArgs, renderJson, requiredString } from './types.js'

type DispatchState = 'done' | 'failed' | 'expired' | 'running'

interface DispatchTarget {
  nodeId: string
  workspaceId: string
}

interface DispatchResult extends TaskResult {
  /** stream mode: dispatched, final reply not collected yet (F-6). */
  pending?: boolean
}

interface DispatchOutput {
  ok: boolean
  taskId?: string
  state: DispatchState
  target?: DispatchTarget
  result?: DispatchResult
  error?: MeshToolError
}

interface DispatchArgs {
  workspaceId: string
  objective: string
  nodeId?: string
  context?: string
  acceptance?: string[]
  sessionMode: 'new' | 'resume'
  sessionId?: string
  maxDurationMs: number
  replyMode: 'final' | 'stream'
}

const DISPATCH_ARG_KEYS = [
  'workspaceId',
  'objective',
  'nodeId',
  'context',
  'acceptance',
  'sessionMode',
  'sessionId',
  'maxDurationMs',
  'replyMode',
] as const

const DISPATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string', description: 'Task board id (ULID-shaped).' },
    state: {
      type: 'string',
      enum: ['done', 'failed', 'expired', 'running'],
      description: 'done = final reply collected; running = stream mode returned early.',
    },
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string' },
        workspaceId: { type: 'string' },
      },
      required: ['nodeId', 'workspaceId'],
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'Final assistant text (or an explicit no-text marker).' },
        sessionId: { type: 'string', description: 'Remote session the task ran in.' },
        artifacts: { type: 'array', items: { type: 'string' } },
        pending: {
          type: 'boolean',
          description: 'stream mode only: true means the prompt was delivered but no final reply is ready.',
        },
      },
      required: ['summary'],
    },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', enum: [...MESH_ERROR_CODE_VALUES] },
        message: { type: 'string' },
        cause: { type: 'string', description: 'Original error name/message/stack for diagnosis.' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['ok', 'state'],
}

function failure(
  code: MeshToolErrorCode,
  message: string,
  options: { taskId?: string; target?: DispatchTarget; state?: 'failed' | 'expired'; cause?: string } = {},
): DispatchOutput {
  const output: DispatchOutput = {
    ok: false,
    state: options.state ?? 'failed',
    error: options.cause === undefined ? { code, message } : { code, message, cause: options.cause },
  }
  if (options.taskId !== undefined) output.taskId = options.taskId
  if (options.target !== undefined) output.target = options.target
  return output
}

function parseDispatchArgs(rawArgs: unknown, runtime: MeshToolRuntime): DispatchArgs {
  const record = asArgsRecord(rawArgs, 'mesh_dispatch')
  rejectUnknownArgs(record, DISPATCH_ARG_KEYS, 'mesh_dispatch')

  const workspaceId = requiredString(record, 'workspaceId', 'mesh_dispatch')
  const objective = requiredString(record, 'objective', 'mesh_dispatch')
  const nodeId = optionalString(record, 'nodeId', 'mesh_dispatch', { nonEmpty: true })
  const context = optionalString(record, 'context', 'mesh_dispatch')
  const sessionId = optionalString(record, 'sessionId', 'mesh_dispatch', { nonEmpty: true })

  const sessionModeRaw = record.sessionMode
  let sessionMode: 'new' | 'resume' = 'new'
  if (sessionModeRaw !== undefined) {
    if (sessionModeRaw !== 'new' && sessionModeRaw !== 'resume') {
      throw new Error('mesh_dispatch: "sessionMode" must be "new" or "resume"')
    }
    sessionMode = sessionModeRaw
  }
  if (sessionMode === 'resume' && sessionId === undefined) {
    throw new Error('mesh_dispatch: sessionMode "resume" requires "sessionId"')
  }

  const replyModeRaw = record.replyMode
  let replyMode: 'final' | 'stream' = 'final'
  if (replyModeRaw !== undefined) {
    if (replyModeRaw !== 'final' && replyModeRaw !== 'stream') {
      throw new Error('mesh_dispatch: "replyMode" must be "final" or "stream"')
    }
    replyMode = replyModeRaw
  }

  const acceptanceRaw = record.acceptance
  let acceptance: string[] | undefined
  if (acceptanceRaw !== undefined) {
    if (!Array.isArray(acceptanceRaw)) throw new Error('mesh_dispatch: "acceptance" must be an array of strings')
    acceptance = acceptanceRaw.map((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`mesh_dispatch: "acceptance[${index}]" must be a non-empty string`)
      }
      return item
    })
  }

  const maxDurationRaw = record.maxDurationMs
  let maxDurationMs = runtime.config.dispatchTimeoutMs
  if (maxDurationRaw !== undefined) {
    if (typeof maxDurationRaw !== 'number' || !Number.isFinite(maxDurationRaw) || maxDurationRaw <= 0) {
      throw new Error('mesh_dispatch: "maxDurationMs" must be a positive finite number')
    }
    maxDurationMs = maxDurationRaw
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error('mesh_dispatch: dispatchTimeoutMs must be a positive finite number')
  }

  return {
    workspaceId,
    objective,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(context === undefined ? {} : { context }),
    ...(acceptance === undefined ? {} : { acceptance }),
    sessionMode,
    ...(sessionId === undefined ? {} : { sessionId }),
    maxDurationMs,
    replyMode,
  }
}

function resolveTarget(args: DispatchArgs, runtime: MeshToolRuntime): DispatchTarget | DispatchOutput {
  // An explicit nodeId is the human override (SPEC §5.4): it wins over the table.
  if (args.nodeId !== undefined) return { nodeId: args.nodeId, workspaceId: args.workspaceId }
  const route = findAssignmentRoute(runtime.assignment, args.workspaceId)
  if (route !== undefined) return { nodeId: route.nodeId, workspaceId: args.workspaceId }
  return failure(
    'invalid-target',
    `workspace "${args.workspaceId}" has no node assignment; pass nodeId explicitly or add it to assignment.yml`,
  )
}

function isDispatchTarget(value: DispatchTarget | DispatchOutput): value is DispatchTarget {
  return 'nodeId' in value
}

function buildTask(taskId: string, target: DispatchTarget, args: DispatchArgs, createdAt: number): Task {
  const policy: TaskPolicy = {
    sessionMode: args.sessionMode,
    maxDurationMs: args.maxDurationMs,
    replyMode: args.replyMode,
    ...(args.sessionMode === 'resume' && args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  }
  return {
    taskId,
    target: { ...target },
    objective: args.objective,
    ...(args.context === undefined ? {} : { context: args.context }),
    ...(args.acceptance === undefined ? {} : { acceptance: [...args.acceptance] }),
    policy,
    lease: { owner: '', fencingToken: 0, expiresAt: 0 },
    state: 'queued',
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * mesh_dispatch — the P2 acceptance path (SPEC §12):
 * Task board create -> claim lease -> createSession -> follow -> prompt ->
 * collect the final reply -> release the lease and record TaskResult.
 * Synthetic failures are returned as data with the MeshErrorCode vocabulary
 * (plus unavailable/unknown-node/invalid-target); only malformed tool arguments
 * throw (the host turns that into a normal isError tool result).
 *
 * Deviation from SPEC §18 (explicit): this tool blocks and returns
 * { taskId, state, target, result|error } instead of { taskId }. The async
 * "taskId + mesh_task_wait" model needs a durable task store; it is deferred to
 * a later increment.
 */
export function createMeshDispatchTool(runtime: MeshToolRuntime): MeshToolDefinition {
  return {
    name: 'mesh_dispatch',
    description:
      '把任务投递到工作区所在节点并阻塞等待最终回复：写入任务板、取得租约、createSession → follow → prompt，收到 turn/end（或 final:true / session/idle）后返回 TaskResult（summary + sessionId）。nodeId 省略时查 assignment.yml。失败以 MeshErrorCode/扩展码（unavailable、unknown-node、invalid-target）返回；没有配置传输时返回 "no transport configured"。注意：与 SPEC §18 的异步 {taskId}+mesh_task_wait 不同（持久化任务板属后续增量），本工具直接返回结果。',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: '目标工作区 id（assignment.yml 的 workspaceId）。' },
        nodeId: { type: 'string', description: '可选。省略时按 assignment.yml 解析；显式指定优先。' },
        objective: { type: 'string', description: '交给远端会话的任务目标（必填）。' },
        context: { type: 'string', description: '可选上下文，随 prompt 一起发送。' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '可选验收标准，作为编号列表附在 prompt 后。',
        },
        sessionMode: {
          type: 'string',
          enum: ['new', 'resume'],
          description: 'new（默认）创建会话；resume 复用 sessionId。',
        },
        sessionId: { type: 'string', description: 'sessionMode=resume 时必填。' },
        maxDurationMs: { type: 'number', description: '等待最终回复的上限（毫秒），默认取插件配置 dispatchTimeoutMs。' },
        replyMode: {
          type: 'string',
          enum: ['final', 'stream'],
          description: 'final（默认）等待最终回复；stream 在 prompt 后立即返回已收到的文本。',
        },
      },
      required: ['workspaceId', 'objective'],
      additionalProperties: false,
    },
    output: {
      schema: DISPATCH_OUTPUT_SCHEMA,
      render: renderJson,
    },
    // Host cancellation must not outrun our own dispatch deadline (F-8).
    timeoutMs: Math.max(runtime.config.dispatchTimeoutMs + 30_000, 60_000),
    async execute(rawArgs, exec) {
      const args = parseDispatchArgs(rawArgs, runtime)

      if (runtime.transport === undefined) {
        // Local degradation, not a remote failure (F-5).
        return failure('unavailable', 'no transport configured')
      }
      const transport = runtime.transport

      const resolved = resolveTarget(args, runtime)
      if (!isDispatchTarget(resolved)) return resolved
      const target = resolved

      const owner = runtime.config.leaseOwner
      if (owner === '') return failure('denied', 'leaseOwner must be a non-empty string', { target })
      const leaseMs = runtime.config.leaseMs
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
        return failure('denied', `leaseMs must be a positive finite number, got ${leaseMs}`, { target })
      }

      const now = runtime.now ?? Date.now
      const nextTaskId = runtime.newTaskId ?? (() => createTaskId(now()))
      let taskId: string | undefined
      for (let attempt = 0; attempt < 3 && taskId === undefined; attempt += 1) {
        const candidate = nextTaskId()
        if (typeof candidate !== 'string' || candidate === '') {
          throw new Error('mesh_dispatch: newTaskId must return a non-empty string')
        }
        if (runtime.board.get(candidate) !== undefined) continue
        if (runtime.board.create(buildTask(candidate, target, args, now()))) taskId = candidate
      }
      if (taskId === undefined) {
        return failure('remote-failure', 'could not allocate a unique task id after 3 attempts', { target })
      }
      const id = taskId

      let ownsLease = false
      let settled = false
      let collector: ReplyCollector | undefined
      let unsubscribe: (() => void) | undefined

      const boardFailure = (): DispatchOutput =>
        failure('unavailable', `task board rejected the lease release or state update for task "${id}"`, {
          taskId: id,
          target,
        })

      let fence: LeaseFence = { owner, fencingToken: 0 }

      const finalize = (
        state: 'done' | 'failed' | 'expired' | 'running',
        patch: { result?: TaskResult; error?: string },
      ): boolean => {
        if (!ownsLease) return false
        // Fenced write first: a preempted owner must not record anything (F-2).
        if (!runtime.board.update(id, { state, ...patch }, fence)) return false
        if (!runtime.board.release(id, owner)) return false
        ownsLease = false
        settled = true
        return true
      }

      try {
        let claimed: boolean
        try {
          claimed = runtime.board.claim(id, owner, leaseMs)
        } catch (err) {
          if (err instanceof RangeError) {
            return failure('denied', `lease rejected: ${err.message}`, { taskId: id, target })
          }
          throw err
        }
        if (!claimed) {
          return failure('denied', `task "${id}" already has a live lease held by another owner`, {
            taskId: id,
            target,
          })
        }
        ownsLease = true
        const claimedTask = runtime.board.get(id)
        fence = { owner, fencingToken: claimedTask?.lease.fencingToken ?? 0 }

        if (!runtime.board.update(id, { state: 'dispatched' }, fence)) return boardFailure()

        let sessionId: string
        if (args.sessionMode === 'resume') {
          if (args.sessionId === undefined) {
            throw new Error('mesh_dispatch: sessionMode "resume" requires "sessionId"')
          }
          sessionId = args.sessionId
        } else {
          sessionId = await transport.createSession(target.nodeId, target.workspaceId)
        }

        const sessionKey = `${target.nodeId}\u0000${sessionId}`
        if (!runtime.board.bindSession(id, sessionKey)) {
          const message = `session "${sessionId}" on node "${target.nodeId}" already has an active task`
          if (!finalize('failed', { error: message })) return boardFailure()
          return failure('denied', message, { taskId: id, target })
        }

        if (!runtime.board.update(id, { state: 'running' }, fence)) return boardFailure()

        collector = new ReplyCollector()
        // Start BEFORE follow: the baseline may be delivered synchronously inside
        // follow() or asynchronously afterwards; neither may count as this reply.
        collector.start()
        let baselineEnded = false
        const follower = transport as typeof transport & {
          supportsBaselineSignal?: boolean
          follow: (
            nodeId: string,
            sessionId: string,
            onEvent: (event: unknown) => void,
            options?: { onBaselineDone?: () => void },
          ) => Promise<() => void>
        }
        unsubscribe = await follower.follow(
          target.nodeId,
          sessionId,
          (event) => {
            collector?.push(event)
          },
          {
            onBaselineDone: () => {
              baselineEnded = true
              collector?.endBaseline()
            },
          },
        )
        // A transport without an explicit baseline signal is assumed to have
        // delivered the baseline by the time follow() resolves.
        if (!baselineEnded && follower.supportsBaselineSignal !== true) collector.endBaseline()
        await transport.prompt(
          target.nodeId,
          sessionId,
          buildDispatchPrompt({
            taskId: id,
            objective: args.objective,
            ...(args.context === undefined ? {} : { context: args.context }),
            ...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
          }),
        )

        if (args.replyMode === 'stream') {
          // If the transport already settled the turn (sync mock), stream can
          // return the real result; otherwise say "dispatched, not ready yet"
          // explicitly instead of pretending success (F-6).
          const settled = collector.outcome()
          if (settled?.kind === 'final') {
            const result: TaskResult = {
              summary: settled.summary.trim() === '' ? '(no assistant text received)' : settled.summary,
              sessionId,
            }
            if (!finalize('done', { result })) return boardFailure()
            return { ok: true, taskId: id, state: 'done', target, result }
          }
          if (settled?.kind === 'failure') {
            const error = meshErrorFrom(settled.failure.code, settled.failure.message)
            if (!finalize('failed', { error: error.message })) return boardFailure()
            return { ok: false, taskId: id, state: 'failed', target, error }
          }
          const snapshot = collector.snapshot()
          const stored: TaskResult = {
            summary: snapshot.latestText === '' ? '(streaming: no assistant text yet)' : snapshot.latestText,
            sessionId,
          }
          if (!finalize('running', { result: stored })) return boardFailure()
          return {
            ok: true,
            taskId: id,
            state: 'running',
            target,
            result: { ...stored, pending: true },
          }
        }

        const outcome = await collector.wait(args.maxDurationMs, exec.signal)
        if (outcome.kind === 'timeout') {
          const message = `dispatch timed out after ${args.maxDurationMs}ms (${outcome.eventCount} event(s) received)`
          if (!finalize('expired', { error: message })) return boardFailure()
          return failure('timeout', message, { taskId: id, target, state: 'expired' })
        }
        if (outcome.kind === 'aborted') {
          const message = 'tool call aborted before a final reply arrived'
          if (!finalize('failed', { error: message })) return boardFailure()
          return failure('timeout', message, { taskId: id, target })
        }
        if (outcome.kind === 'failure') {
          const error = meshErrorFrom(outcome.failure.code, outcome.failure.message)
          if (!finalize('failed', { error: error.message })) return boardFailure()
          return { ok: false, taskId: id, state: 'failed', target, error }
        }

        const result: TaskResult = {
          summary: outcome.summary.trim() === '' ? '(no assistant text received)' : outcome.summary,
          sessionId,
        }
        if (!finalize('done', { result })) return boardFailure()
        return { ok: true, taskId: id, state: 'done', target, result }
      } catch (err) {
        const error = toMeshError(err)
        if (!settled) {
          try {
            const wrote = runtime.board.update(
              id,
              { state: error.code === 'timeout' ? 'expired' : 'failed', error: error.message },
              fence,
            )
            if (!wrote) {
              // Another owner took the lease while this call was in flight: the
              // late write is correctly rejected (F-2), but keep a trace.
              console.warn(`[mesh] task "${id}" was fenced out before the failure could be recorded`)
            }
          } catch (boardError) {
            console.warn(`[mesh] failed to record dispatch failure for task "${id}":`, boardError)
          }
        }
        return {
          ok: false,
          taskId: id,
          state: error.code === 'timeout' ? 'expired' : 'failed',
          target,
          error,
        }
      } finally {
        collector?.dispose()
        if (unsubscribe !== undefined) {
          try {
            unsubscribe()
          } catch {
            // Unsubscribe is cleanup; never mask the dispatch result.
          }
        }
        if (ownsLease) {
          try {
            runtime.board.release(id, owner)
          } catch {
            // Cleanup only.
          }
          ownsLease = false
        }
      }
    },
  }
}
