import type { Context } from '@deepseek-ai/cordis'
import type { MeshToolRuntime } from '../tools/types.js'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'

/**
 * Read the tail of a remote session, for the page's conversation viewer.
 *
 * History lives on the owning machine; this route asks the transport for it and
 * never caches — the page polls, the peer is the only authority.
 */

export const MESH_SESSION_PATH = '/api/mesh/session'

export interface MeshSessionControl {
  runtime: MeshToolRuntime
}

export async function handleSessionRead(request: Request, control: MeshSessionControl): Promise<Response> {
  const url = new URL(request.url)
  const nodeId = url.searchParams.get('nodeId') ?? ''
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (nodeId === '' || sessionId === '') {
    return jsonResponse({ ok: false, error: 'nodeId and sessionId are required' }, 400)
  }
  const rawLimit = url.searchParams.get('limit')
  const parsed = rawLimit === null ? 50 : Number(rawLimit)
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50

  const transport = control.runtime.transport
  if (transport === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'no transport configured' }, 200)
  }
  if (transport.readSession === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'the active transport cannot read session history' }, 200)
  }
  try {
    const messages = await transport.readSession(nodeId, sessionId, limit)
    return jsonResponse({ ok: true, messages }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return jsonResponse(code === undefined ? { ok: false, error: message } : { ok: false, code, error: message }, 200)
  }
}

export function mountMeshSessionRoute(ctx: MeshRouteContext, control: MeshSessionControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_SESSION_PATH,
    methods: ['GET'],
    fetch: async (request) => {
      try {
        return await handleSessionRead(request, control)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

export function registerMeshSessionRoute(ctx: Context, runtime: MeshToolRuntime): void {
  withConnection(ctx, (inner) => mountMeshSessionRoute(inner, { runtime }))
}
