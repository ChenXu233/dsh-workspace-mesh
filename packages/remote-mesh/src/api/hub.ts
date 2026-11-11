/**
 * The hub's HTTP surface.
 *
 * Every route is below the fence and authenticated by a mesh token minted from
 * the hub's \`meshSecret\` — the same credential the relay already uses, so a
 * joining node needs no new account on the hub.
 *
 * The routes are deliberately dumb: a directory, a queue per node, and a
 * blocking forward. The hub never executes anything and never reads a peer's
 * session data; it moves one HTTP request and one response between two machines
 * that cannot reach each other.
 */
import type { Context } from '@deepseek-ai/cordis'

import { verifyMeshToken } from './mesh-auth.js'
import { jsonResponse, mountExactRoute } from './mount.js'

import { registerMeshPublicRoute } from './mesh-http.js'
import { FORWARD_TIMEOUT_MS } from '../hub/registry.js'
import type { ForwardEnvelope, HubNodeRecord, HubRegistry } from '../hub/registry.js'

export const MESH_HUB_JOIN_PATH = '/api/mesh/hub/join'
export const MESH_HUB_NODES_PATH = '/api/mesh/hub/nodes'
export const MESH_HUB_INBOX_PATH = '/api/mesh/hub/inbox'
export const MESH_HUB_RESULT_PATH = '/api/mesh/hub/result'
/** The forward route; the target node rides `?nodeId=`. */
export const MESH_HUB_FORWARD_PATH = '/api/mesh/hub/forward'

/** What the hub routes need from the composition. */
export interface MeshHubControl {
  /** The hub's own shared secret; empty = hub routes refuse. */
  secret: () => string
  registry: HubRegistry
  now?: () => number
}

/** Auth failure shape shared by every hub route. */
function refuse(reason: string): Response {
  return jsonResponse({ ok: false, error: 'hub token rejected: ' + reason }, 401)
}

/**
 * Check the mesh token in a body or on the query string.
 * @param control - hub secrets.
 * @param token - presented token.
 * @returns undefined when accepted, or the refusal to return.
 */
function authorise(control: MeshHubControl, token: unknown): Response | undefined {
  const secret = control.secret()
  if (secret === '') return jsonResponse({ ok: false, error: 'this node has no meshSecret; the hub cannot authenticate callers' }, 503)
  const check = verifyMeshToken(secret, token, (control.now ?? Date.now)())
  return check.ok ? undefined : refuse(check.reason)
}

/** Read a JSON body, answering 400 on malformed input. */
async function readJson(request: Request, thing: string): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new Error(thing + ' must be a JSON object')
  }
}

/** Project one record for the wire. */
function toWire(record: HubNodeRecord): Record<string, unknown> {
  return {
    nodeId: record.nodeId,
    url: record.url,
    joinedAt: record.joinedAt,
    lastSeenAt: record.lastSeenAt,
  }
}

/**
 * Register a node and hand it the directory.
 * @param request - POST `{ token, nodeId, url? }`.
 * @param control - hub state.
 * @returns the node record plus every other node.
 */
export async function handleHubJoin(request: Request, control: MeshHubControl): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJson(request, 'join body')
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
  }
  const denied = authorise(control, body.token)
  if (denied !== undefined) return denied
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  if (nodeId === '') return jsonResponse({ ok: false, error: 'nodeId must be a non-empty string' }, 400)
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const joined = control.registry.join({ nodeId, url })
  return jsonResponse({
    ok: true,
    node: toWire(joined.node),
    peers: joined.peers.map(toWire),
    revision: control.registry.size(),
  }, 200)
}

/**
 * The directory.
 * @param request - GET `?token=`.
 * @param control - hub state.
 * @returns every known node.
 */
export async function handleHubNodes(request: Request, control: MeshHubControl): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token')
  const denied = authorise(control, token)
  if (denied !== undefined) return denied
  return jsonResponse({ ok: true, nodes: control.registry.directory().map(toWire), revision: control.registry.size() }, 200)
}

/**
 * Long-poll: take the next request addressed to this node.
 * @param request - GET `?token=&nodeId=&wait=`.
 * @param control - hub state.
 * @returns one envelope, or null when the poll ran out.
 */
export async function handleHubInbox(request: Request, control: MeshHubControl): Promise<Response> {
  const params = new URL(request.url).searchParams
  const denied = authorise(control, params.get('token'))
  if (denied !== undefined) return denied
  const nodeId = (params.get('nodeId') ?? '').trim()
  if (nodeId === '') return jsonResponse({ ok: false, error: 'nodeId is required' }, 400)
  const wait = Number(params.get('wait') ?? '0')
  const job = await control.registry.take(nodeId, Number.isFinite(wait) ? wait : 0)
  return jsonResponse({
    ok: true,
    job: job === undefined ? null : { id: job.id, ...job.envelope },
    // The directory rides along: a joining node is announced to everyone on the
    // poll they already run, so the hub never has to dial anybody.
    nodes: control.registry.directory().map(toWire),
    revision: control.registry.size(),
  }, 200)
}

/**
 * Deliver a node's answer to whoever is waiting for it.
 * @param request - POST `{ token, id, status, headers?, body? }`.
 * @param control - hub state.
 * @returns whether a caller was still waiting.
 */
export async function handleHubResult(request: Request, control: MeshHubControl): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJson(request, 'result body')
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
  }
  const denied = authorise(control, body.token)
  if (denied !== undefined) return denied
  const id = typeof body.id === 'string' ? body.id : ''
  if (id === '') return jsonResponse({ ok: false, error: 'id is required' }, 400)
  const status = typeof body.status === 'number' && Number.isInteger(body.status) ? body.status : 0
  if (status < 100 || status > 599) return jsonResponse({ ok: false, error: 'status must be an HTTP status code' }, 400)
  const rawHeaders = body.headers
  const headers: Record<string, string> = {}
  if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const delivered = control.registry.settle(id, {
    status,
    headers,
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
  })
  return jsonResponse({ ok: true, delivered }, 200)
}

/**
 * Forward one request to a node that has no inbound port.
 * @param request - POST `{ token, method, path, headers?, body? }`.
 * @param nodeId - target node from the path.
 * @param control - hub state.
 * @returns the node's mirrored response.
 */
export async function handleHubForward(request: Request, nodeId: string, control: MeshHubControl): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJson(request, 'forward body')
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
  }
  const denied = authorise(control, body.token)
  if (denied !== undefined) return denied
  const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET'
  const path = typeof body.path === 'string' ? body.path : ''
  if (!path.startsWith('/')) return jsonResponse({ ok: false, error: 'path must start with /' }, 400)
  const rawHeaders = body.headers
  const headers: Record<string, string> = {}
  if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const envelope: ForwardEnvelope = {
    method,
    path,
    headers,
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
  }
  const timeout = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : FORWARD_TIMEOUT_MS
  try {
    const result = await control.registry.enqueue(nodeId.trim(), envelope, timeout)
    return jsonResponse({ ok: true, result }, 200)
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 504)
  }
}

/** Wrap a handler so one thrown error cannot take the route down. */
function guarded(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request)
    } catch (err) {
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }
}

/** Mount every hub route below the fence. */
export function registerMeshHubRoutes(ctx: Context, control: MeshHubControl): void {
  registerMeshPublicRoute(ctx, MESH_HUB_JOIN_PATH, guarded(request => handleHubJoin(request, control)))
  registerMeshPublicRoute(ctx, MESH_HUB_NODES_PATH, guarded(request => handleHubNodes(request, control)))
  registerMeshPublicRoute(ctx, MESH_HUB_INBOX_PATH, guarded(request => handleHubInbox(request, control)))
  registerMeshPublicRoute(ctx, MESH_HUB_RESULT_PATH, guarded(request => handleHubResult(request, control)))
  registerMeshPublicRoute(ctx, MESH_HUB_FORWARD_PATH, guarded((request) => {
    const nodeId = new URL(request.url).searchParams.get('nodeId') ?? ''
    if (nodeId === '') return Promise.resolve(jsonResponse({ ok: false, error: 'nodeId is required' }, 400))
    return handleHubForward(request, nodeId, control)
  }))
}

export { mountExactRoute, jsonResponse }