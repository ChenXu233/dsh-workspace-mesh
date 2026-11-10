import type { Context } from '@deepseek-ai/cordis'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import type { MeshToolRuntime } from '../tools/types.js'
import type { MeshControlOp } from '../transport/types.js'

/**
 * Browser-facing administration of a peer's workspaces.
 *
 * The sidebar's remote section needs two things the `mesh_*` tools do not offer:
 * the directory listing of a machine (to pick a folder there) and the right to
 * register a Workspace on it. Both run through the transport's control
 * capability, which presents the mesh secret to the peer's relay — this route
 * only validates the request and maps the outcome.
 *
 * It is not part of the task data plane: nothing here creates a Session or
 * carries a task. The five-method plane keeps its narrow shape.
 */

export const MESH_REMOTE_PATH = '/api/mesh/remote'

const REMOTE_OPS: ReadonlySet<string> = new Set<MeshControlOp>(['browse', 'workspace-create', 'mkdir'])

export interface MeshRemoteControl {
  runtime: MeshToolRuntime
}

/**
 * Validate one administration call and hand it to the transport.
 * @param request - the browser's POST.
 * @param control - mesh runtime; its transport must offer the control capability.
 * @returns the peer's answer, or a mesh-shaped failure with HTTP 200.
 */
export async function handleRemote(request: Request, control: MeshRemoteControl): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method must be POST' }, 405)
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
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : ''
  if (nodeId === '') return jsonResponse({ ok: false, error: 'nodeId is required' }, 400)
  const op = record.op
  if (typeof op !== 'string' || !REMOTE_OPS.has(op)) {
    return jsonResponse({ ok: false, error: `op must be one of ${[...REMOTE_OPS].join(' | ')}` }, 400)
  }
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (op === 'workspace-create' && (path === '' || !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path))) {
    return jsonResponse({ ok: false, error: 'path must be an absolute directory path' }, 400)
  }
  const transport = control.runtime.transport
  if (transport?.control === undefined) {
    return jsonResponse({ ok: false, error: 'transport cannot administer peers (no control capability)' }, 503)
  }
  const args: Record<string, unknown> = { path }
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (title !== '') args.title = title
  if (op === 'mkdir') {
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '' || name.includes('/') || name.includes('\\')) {
      return jsonResponse({ ok: false, error: 'name must be a single path segment' }, 400)
    }
    args.name = name
  }
  try {
    const value = await transport.control(nodeId, op as MeshControlOp, args)
    return jsonResponse({ ok: true, value }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'remote-failure'
    return jsonResponse({ ok: false, code, error: message }, 200)
  }
}

export function mountMeshRemoteRoute(ctx: MeshRouteContext, control: MeshRemoteControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_REMOTE_PATH,
    methods: ['POST'],
    fetch: async (request) => handleRemote(request, control),
  }
  return mountExactRoute(ctx, route)
}

/** Serve POST /api/mesh/remote inside Connection's authenticated fence. */
export function registerMeshRemoteRoute(ctx: Context, runtime: MeshToolRuntime): void {
  withConnection(ctx, (inner) => mountMeshRemoteRoute(inner, { runtime }))
}