import type { Context } from '@deepseek-ai/cordis'
import { verifyMeshToken } from './mesh-auth.js'
import { registerMeshPublicRoute } from './mesh-http.js'
import { jsonResponse, mountExactRoute } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'

/**
 * Execute one session operation locally on behalf of a paired peer.
 *
 * This is the self-healing half of the transport: the caller never needs the
 * node's web login token (which rotates on every restart). It presents a mesh
 * token minted from the shared secret, and this node runs the operation against
 * its own services — so the agent loop and the files stay right here.
 *
 * Deliberately narrow: four operations, no arbitrary method dispatch.
 */

export const MESH_RELAY_PATH = '/api/mesh/relay'

export type MeshRelayOp = 'list' | 'create' | 'prompt' | 'page' | 'workspaces'

/**
 * The shape of `ctx.sessionController` as this plugin uses it.
 *
 * Measured against `@deepseek-ai/dsh-api-session-controller` 0.2.1-rc.5: the
 * service *is* the generated `session` namespace, so its signatures are the
 * remote ones, not the internal command controller's. `prompt`'s second
 * argument is the caller's `AbortSignal` (the source metadata is built inside
 * from `request.requestId`), and `list` takes an (unused) request first.
 * Passing a source object there is what produced
 * "signal.throwIfAborted is not a function".
 */
export interface SessionControllerLike {
  list(request?: unknown, signal?: AbortSignal): Promise<unknown>
  create(request: unknown): Promise<unknown>
  prompt(request: unknown, signal?: AbortSignal): Promise<unknown>
  page(request: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface MeshRelayControl {
  secret: () => string | undefined
  controller: () => SessionControllerLike | undefined
  /** Native workspace registry payload; absent compositions report an empty list. */
  workspaces?: () => unknown
  now?: () => number
}

const RELAY_OPS: ReadonlySet<string> = new Set<MeshRelayOp>(['list', 'create', 'prompt', 'page', 'workspaces'])

export async function handleRelay(request: Request, control: MeshRelayControl): Promise<Response> {
  const secret = control.secret()
  if (secret === undefined || secret === '') {
    return jsonResponse({ ok: false, error: 'meshSecret is not configured on this node' }, 503)
  }
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
  const now = (control.now ?? Date.now)()
  const check = verifyMeshToken(secret, record.token, now)
  if (!check.ok) {
    return jsonResponse({ ok: false, error: `mesh token rejected: ${check.reason}` }, 401)
  }
  const op = record.op
  if (typeof op !== 'string' || !RELAY_OPS.has(op)) {
    return jsonResponse({ ok: false, error: `op must be one of ${[...RELAY_OPS].join(' | ')}` }, 400)
  }
  const args = (record.args ?? {}) as Record<string, unknown>
  // The controller calls signal.throwIfAborted() before touching the log, so the
  // signal must be a real AbortSignal. The HTTP bridge does not hand one through.
  const signal = new AbortController().signal
  if (op === 'workspaces') {
    return jsonResponse({ ok: true, value: control.workspaces?.() ?? { ok: true, workspaces: [] } }, 200)
  }
  const controller = control.controller()
  if (controller === undefined) {
    return jsonResponse({ ok: false, error: 'sessionController is not available in this composition' }, 503)
  }
  try {
    switch (op as MeshRelayOp) {
      case 'list':
        return jsonResponse({ ok: true, value: await controller.list(args._request ?? {}, signal) }, 200)
      case 'create':
        // create() has no signal parameter: it resolves or reuses a blank Session.
        return jsonResponse({ ok: true, value: await controller.create(args.request ?? {}) }, 200)
      case 'page':
        return jsonResponse({ ok: true, value: await controller.page(args.request ?? {}, signal) }, 200)
      case 'prompt':
        // The controller records the source itself from request.requestId; the
        // second argument is the cancellation signal, not the source.
        return jsonResponse({ ok: true, value: await controller.prompt(args.request ?? {}, signal) }, 200)
      default:
        return jsonResponse({ ok: false, error: 'unreachable' }, 500)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return jsonResponse(code === undefined ? { ok: false, error: message } : { ok: false, code, error: message }, 200)
  }
}

export function mountMeshRelayRoute(ctx: MeshRouteContext, control: MeshRelayControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_RELAY_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        return await handleRelay(request, control)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

/** Read `ctx.sessionController` without a hard injection. */
export function readSessionController(ctx: unknown): SessionControllerLike | undefined {
  const candidate = ctx as { get?: (name: string) => unknown; sessionController?: unknown } | undefined
  if (candidate === undefined || candidate === null) return undefined
  let service: unknown
  try {
    service = typeof candidate.get === 'function' ? candidate.get('sessionController') : candidate.sessionController
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  const record = service as Record<string, unknown>
  const ok = ['list', 'create', 'prompt', 'page'].every((method) => typeof record[method] === 'function')
  return ok ? (service as SessionControllerLike) : undefined
}

export function registerMeshRelayRoute(
  ctx: Context,
  source: unknown,
  secret: () => string | undefined,
  workspaces?: () => unknown,
): void {
  const control: MeshRelayControl = {
    secret,
    controller: () => readSessionController(source),
    ...(workspaces === undefined ? {} : { workspaces }),
  }
  // The mesh token is the credential here, so the route lives below the browser
  // fence and checks the token itself.
  registerMeshPublicRoute(ctx, MESH_RELAY_PATH, (request) => handleRelay(request, control))
}
