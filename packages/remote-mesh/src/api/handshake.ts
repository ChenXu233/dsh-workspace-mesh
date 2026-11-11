import type { Context } from '@deepseek-ai/cordis'
import { MESH_TOKEN_TTL_MS, mintMeshToken, NonceCache, verifyHandshake } from './mesh-auth.js'
import { registerMeshPublicRoute } from './mesh-http.js'
import { jsonResponse, mountExactRoute } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'

/**
 * Peer asks for a mesh credential.
 *
 * Authenticated by the shared `meshSecret` (HMAC over nodeId + timestamp + nonce),
 * not by the web login token: that is what lets a caller recover by itself after
 * the peer restarts and its login token rotates.
 */

export const MESH_HANDSHAKE_PATH = '/api/mesh/handshake'

export interface MeshHandshakeControl {
  /** Shared secret; undefined disables the route. */
  secret: () => string | undefined
  nonces: NonceCache
  now?: () => number
}

export async function handleHandshake(request: Request, control: MeshHandshakeControl): Promise<Response> {
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
  const now = (control.now ?? Date.now)()
  const check = verifyHandshake(secret, body, control.nonces, now)
  if (!check.ok) {
    return jsonResponse({ ok: false, error: `handshake rejected: ${check.reason}` }, 401)
  }
  const nodeId = String((body as Record<string, unknown>).nodeId)
  const claims = { nodeId, expiresAt: now + MESH_TOKEN_TTL_MS }
  return jsonResponse({ ok: true, token: mintMeshToken(secret, claims), expiresAt: claims.expiresAt }, 200)
}

export function mountMeshHandshakeRoute(ctx: MeshRouteContext, control: MeshHandshakeControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_HANDSHAKE_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        return await handleHandshake(request, control)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

/** One handshake control: one nonce cache, shared by the route and any relayed call. */
export function meshHandshakeControl(secret: () => string | undefined): MeshHandshakeControl {
  return { secret, nonces: new NonceCache() }
}

export function registerMeshHandshakeRoute(
  ctx: Context,
  secret: () => string | undefined,
  control: MeshHandshakeControl = meshHandshakeControl(secret),
): void {
  // Must sit below the browser fence: the caller has no cookie yet.
  registerMeshPublicRoute(ctx, MESH_HANDSHAKE_PATH, (request) => handleHandshake(request, control))
}