/**
 * One dispatch round trip: the page sends an objective to the machine that owns
 * a Workspace and waits for the final reply.
 *
 * The route is the same one the model's `mesh_dispatch` tool uses — one
 * validator, one lease, one reply collector — so a person and an agent cannot
 * get different behavior out of the same words.
 */
import type { DispatchTarget } from './dispatch-target'

/** What one dispatch settled to, as the page shows it. */
export interface DispatchReply {
  /** True when the peer finished the objective and a summary came back. */
  readonly ok: boolean
  /** Board state: done, failed, expired, or running (stream mode only). */
  readonly state: string
  /** Final reply text; empty when the peer failed before answering. */
  readonly summary: string
  /** Peer error message, when it failed. */
  readonly error: string
  /** Board id, for following the task up elsewhere. */
  readonly taskId: string
}

interface DispatchWire {
  ok?: unknown
  state?: unknown
  taskId?: unknown
  result?: { summary?: unknown } | null
  error?: { message?: unknown } | null
}

/**
 * Dispatch one objective to the target's machine.
 * @param target - the Workspace to run in.
 * @param objective - what to ask for.
 * @param signal - cancellation; the Host stops collecting when it aborts.
 * @returns the settled reply.
 * @throws when the route itself refuses the request (bad body, no transport).
 */
export async function dispatchToTarget(
  target: DispatchTarget,
  objective: string,
  signal?: AbortSignal,
): Promise<DispatchReply> {
  const response = await fetch('/api/mesh/dispatch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ nodeId: target.nodeId, workspaceId: target.workspaceId, objective }),
    ...(signal === undefined ? {} : { signal }),
  })
  const payload = (await response.json().catch(() => undefined)) as DispatchWire | undefined
  if (payload === undefined) throw new Error(`dispatch failed (HTTP ${String(response.status)})`)
  const summary = typeof payload.result?.summary === 'string' ? payload.result.summary : ''
  const error = typeof payload.error?.message === 'string' ? payload.error.message : ''
  return {
    ok: payload.ok === true,
    state: typeof payload.state === 'string' ? payload.state : 'failed',
    summary,
    error,
    taskId: typeof payload.taskId === 'string' ? payload.taskId : '',
  }
}
