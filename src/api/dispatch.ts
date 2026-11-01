import type { Context } from '@deepseek-ai/cordis'
import { createMeshDispatchTool } from '../tools/dispatch.js'
import type { MeshToolRuntime } from '../tools/types.js'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'

/**
 * Browser-triggered dispatch, served next to the read-only snapshot.
 *
 * The model reaches the same code through the `mesh_dispatch` tool; this route
 * exists so a person can send a message to a remote workspace from the page
 * without waiting for a chat turn. It reuses the tool definition verbatim, so
 * validation, the lease invariant, the reply collector and the error vocabulary
 * cannot drift between the two entry points.
 */

export const MESH_DISPATCH_PATH = '/api/mesh/dispatch'

export interface MeshDispatchControl {
  runtime: MeshToolRuntime
}

/** Arguments the page may send; everything else is rejected before the tool runs. */
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

export async function handleDispatch(request: Request, control: MeshDispatchControl): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ ok: false, error: 'body must be JSON' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
  }
  const record = body as Record<string, unknown>
  const args: Record<string, unknown> = {}
  for (const key of DISPATCH_ARG_KEYS) {
    if (record[key] !== undefined) args[key] = record[key]
  }
  if (typeof args.workspaceId !== 'string' || args.workspaceId.trim() === '') {
    return jsonResponse({ ok: false, error: 'workspaceId is required' }, 400)
  }
  if (typeof args.objective !== 'string' || args.objective.trim() === '') {
    return jsonResponse({ ok: false, error: 'objective is required' }, 400)
  }

  const tool = createMeshDispatchTool(control.runtime)
  try {
    // The tool blocks until the final reply (or its own deadline), exactly like
    // the model-visible call.
    const result = await tool.execute(args, {})
    return jsonResponse(result, 200)
  } catch (err) {
    // Malformed arguments are the only throwing path; the tool returns business
    // failures as data with a MeshErrorCode.
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ ok: false, error: message }, 400)
  }
}

/** Serve POST /api/mesh/dispatch. */
export function mountMeshDispatchRoute(ctx: MeshRouteContext, control: MeshDispatchControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_DISPATCH_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        return await handleDispatch(request, control)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

export function registerMeshDispatchRoute(ctx: Context, runtime: MeshToolRuntime): void {
  withConnection(ctx, (inner) => mountMeshDispatchRoute(inner, { runtime }))
}
