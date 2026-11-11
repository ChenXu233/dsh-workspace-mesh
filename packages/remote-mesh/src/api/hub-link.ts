/**
 * Joining a domain.
 *
 * One machine is the hub; every other machine needs exactly one link to join it.
 * The link carries the hub's URL and the shared secret, so a new machine types
 * nothing: open the link, its page posts the payload back, the config gains a
 * `hub` entry plus that secret, and the agent starts registering.
 *
 * The hub's own noise (which node ids exist) is not in the link — the directory
 * arrives from the hub after the join.
 */
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import { writeConfigOverride } from '../config/store.js'
import type { MeshToolRuntime } from '../tools/types.js'

export const MESH_HUB_LINK_PATH = '/api/mesh/hub-link'
export const MESH_HUB_ADOPT_PATH = '/api/mesh/hub-adopt'
/** Query parameter the client half watches for. */
export const HUB_PARAM = 'mesh-hub'
/** Bumped when the payload shape changes. */
export const HUB_PAYLOAD_VERSION = 1

/** What a join link carries. */
export interface HubPayload {
  readonly v: number
  /** Hub origin, no trailing slash. */
  readonly url: string
  /** Shared secret both sides use for mesh tokens. */
  readonly secret: string
  /** Suggested node id for the hub itself; the joiner may keep or edit it. */
  readonly nodeId: string
}

export interface MeshHubLinkControl {
  runtime: MeshToolRuntime
  file: string
  /** Current secret (minted and persisted when empty). */
  secret: () => string
  setSecret: (secret: string) => void
  /** Current public address of this node. */
  publicUrl: () => string
  /** Persist the joining side. */
  setHub: (hub: { url: string; nodeId?: string }) => void
}

/**
 * Encode one payload as the link token.
 * @param payload - decoded fields.
 * @returns base64url JSON.
 */
export function encodeHubPayload(payload: HubPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode a join token, refusing anything this build cannot adopt.
 * @param token - base64url payload or a whole link.
 * @returns the payload or the reason it was refused.
 */
export function decodeHubPayload(token: string): HubPayload | { error: string } {
  const trimmed = token.trim()
  if (trimmed === '') return { error: 'hub token is empty' }
  let body = trimmed
  const at = body.indexOf(HUB_PARAM + '=')
  if (at >= 0) body = body.slice(at + HUB_PARAM.length + 1)
  const cut = body.search(/[&#]/u)
  if (cut >= 0) body = body.slice(0, cut)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { error: 'hub token does not decode to JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'hub token must be a JSON object' }
  const record = parsed as Record<string, unknown>
  if (record.v !== HUB_PAYLOAD_VERSION) return { error: 'hub token version ' + String(record.v) + ' is not supported by this build' }
  const url = typeof record.url === 'string' ? record.url.trim().replace(/\/+$/u, '') : ''
  const secret = typeof record.secret === 'string' ? record.secret.trim() : ''
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : ''
  if (url === '' || !/^https?:\/\/[^\s]+$/u.test(url)) return { error: 'hub token url must be an http(s) URL' }
  if (secret === '') return { error: 'hub token has no secret' }
  return { v: HUB_PAYLOAD_VERSION, url, secret, nodeId }
}

/** The origin this request reached us on. */
function originOf(request: Request): string {
  const headers = request.headers
  const origin = headers.get('origin')
  if (origin !== null && origin !== '') return origin.replace(/\/+$/u, '')
  const referer = headers.get('referer')
  if (referer !== null && referer !== '') {
    try {
      return new URL(referer).origin
    } catch {
      // fall through to the Host header
    }
  }
  const host = headers.get('host') ?? ''
  const proto = headers.get('x-forwarded-proto') ?? 'http'
  return host === '' ? '' : proto + '://' + host
}

/**
 * Answer with a join link for this node as the hub.
 * @param request - GET from the settings page.
 * @param control - config access.
 * @returns `{ link, url, nodeId }`.
 */
export async function handleHubLink(request: Request, control: MeshHubLinkControl): Promise<Response> {
  const url = control.publicUrl() !== '' ? control.publicUrl() : originOf(request)
  if (url === '') return jsonResponse({ ok: false, error: 'cannot tell which address this hub is served at; set publicUrl' }, 400)
  let secret = control.secret()
  if (secret === '') {
    secret = 'mesh-' + randomBytes(18).toString('base64url')
    control.setSecret(secret)
  }
  const machine = hostname()
  const nodeId = /^[0-9a-f]{12,}$/i.test(machine) ? new URL(url).host : machine
  const token = encodeHubPayload({ v: HUB_PAYLOAD_VERSION, url, secret, nodeId })
  return jsonResponse({ ok: true, url, nodeId, link: url + '/#' + HUB_PARAM + '=' + token }, 200)
}

/**
 * Adopt a join link on this machine: become a node of that hub.
 * @param request - POST `{ token }` or `{ link }`.
 * @param control - config access.
 * @returns the hub that was adopted.
 */
export async function handleHubAdopt(request: Request, control: MeshHubLinkControl): Promise<Response> {
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
  const raw = typeof record.token === 'string' ? record.token : typeof record.link === 'string' ? record.link : ''
  const payload = decodeHubPayload(raw)
  if ('error' in payload) return jsonResponse({ ok: false, error: payload.error }, 400)
  // The shared secret is what makes the hub's tokens verifiable in both
  // directions, so adopting a domain adopts it.
  writeConfigOverride({ hub: { url: payload.url }, meshSecret: payload.secret }, control.file)
  control.setSecret(payload.secret)
  control.setHub({ url: payload.url })
  control.runtime.reload?.()
  return jsonResponse({ ok: true, hub: { url: payload.url }, secret: payload.secret }, 200)
}

/** Mount the join-link generator and the adopter inside the browser fence. */
export function registerMeshHubLinkRoutes(ctx: Context, control: MeshHubLinkControl): void {
  withConnection(ctx, (inner) => {
    const routes: Array<Omit<MeshFetchRoute, 'requestBody'>> = [
      {
        path: MESH_HUB_LINK_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          try {
            return await handleHubLink(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      },
      {
        path: MESH_HUB_ADOPT_PATH,
        methods: ['POST'],
        fetch: async (request) => {
          try {
            return await handleHubAdopt(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      },
    ]
    routes.map(route => mountExactRoute(inner, route))
    return true
  })
}
