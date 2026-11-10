/**
 * One-click pairing.
 *
 * Hand-editing `mesh-config.json` is the slow part of joining two machines: the
 * login token rotates on every restart and the shared secret has to match on
 * both sides. A pairing link carries everything the other machine needs —
 * this node's id, the URL to reach it, and the secret that makes its relay
 * answer — and importing it writes one peer entry. No login token: the secret
 * is the credential, and it survives restarts.
 *
 * The link is `<origin>/#mesh-pair=<base64url json>` so it opens straight in
 * the other machine's browser; the client half imports it and strips the
 * parameter. The payload rides the fragment on purpose: the web UI answers
 * `/?token=` with a redirect to `/`, which drops the query string but keeps the
 * fragment — a query parameter would be gone before the client could read it.
 */
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import { writeConfigOverride } from '../config/store.js'
import type { MeshToolRuntime } from '../tools/types.js'

export const MESH_PAIR_LINK_PATH = '/api/mesh/pair-link'
export const MESH_PAIR_PATH = '/api/mesh/pair'
/** Query parameter the client half watches for. */
export const PAIR_PARAM = 'mesh-pair'
/** Bumped when the payload shape changes; an unknown version is refused, not guessed. */
export const PAIR_PAYLOAD_VERSION = 1

/** What one link carries. */
export interface PairPayload {
  readonly v: number
  /** How the importing machine will address this one. */
  readonly nodeId: string
  /** Origin to reach this node at (no trailing slash). */
  readonly url: string
  /** Shared secret this node's relay verifies. */
  readonly secret: string
}

export interface MeshPairControl {
  runtime: MeshToolRuntime
  /** Override file the peer entry lands in. */
  file: string
  /** Peers currently configured on this node. */
  peers: () => ReadonlyArray<{ nodeId: string, baseUrl: string, token: string, secret?: string }>
  /** This node's shared secret, creating one on first use. */
  secret: () => string
  /** Persist a new secret for this node. */
  setSecret: (secret: string) => void
}

/**
 * Encode one payload as the link token.
 * @param payload - decoded fields.
 * @returns base64url JSON, safe in a query string.
 */
export function encodePairToken(payload: PairPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode a link token, refusing anything this build cannot import.
 * @param token - base64url payload (a whole link is accepted too).
 * @returns the payload, or the reason it was refused.
 */
export function decodePairToken(token: string): PairPayload | { error: string } {
  const trimmed = token.trim()
  if (trimmed === '') return { error: 'pair token is empty' }
  let body = trimmed
  const at = body.indexOf(PAIR_PARAM + '=')
  if (at >= 0) body = body.slice(at + PAIR_PARAM.length + 1)
  const cut = body.search(/[&#]/u)
  if (cut >= 0) body = body.slice(0, cut)
  let decoded: string
  try {
    decoded = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    return { error: 'pair token is not base64url' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return { error: 'pair token does not decode to JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'pair token must be a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.v !== PAIR_PAYLOAD_VERSION) {
    return { error: 'pair token version ' + String(record.v) + ' is not supported by this build' }
  }
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : ''
  const url = typeof record.url === 'string' ? record.url.trim().replace(/\/+$/u, '') : ''
  const secret = typeof record.secret === 'string' ? record.secret.trim() : ''
  if (nodeId === '') return { error: 'pair token has no nodeId' }
  if (url === '') return { error: 'pair token has no url' }
  if (secret === '') return { error: 'pair token has no secret' }
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { error: 'pair token url must be http(s)' }
    }
  } catch {
    return { error: 'pair token url is not a URL' }
  }
  return { v: PAIR_PAYLOAD_VERSION, nodeId, url, secret }
}

/** The origin this request reached us on: what the other machine should call. */
function originOf(request: Request): string {
  const headers = request.headers
  const origin = headers.get('origin')
  if (origin !== null && origin !== '') return origin.replace(/\/+$/u, '')
  const referer = headers.get('referer')
  if (referer !== null && referer !== '') {
    try {
      return new URL(referer).origin
    } catch {
      // A malformed referer falls through to the Host header.
    }
  }
  const host = headers.get('host') ?? ''
  const proto = headers.get('x-forwarded-proto') ?? 'http'
  return host === '' ? '' : proto + '://' + host
}

/** A secret this node can hand out; stable once created. */
function mintSecret(): string {
  return 'mesh-' + randomBytes(18).toString('base64url')
}

/**
 * Answer with a pairing link for this node.
 * @param request - GET from the settings page, addressed at this node.
 * @param control - runtime config plus the override file.
 * @returns `{ link, url, nodeId }`.
 */
export async function handlePairLink(request: Request, control: MeshPairControl): Promise<Response> {
  const url = originOf(request)
  if (url === '') return jsonResponse({ ok: false, error: 'cannot tell which origin this node is served at' }, 400)
  const asked = new URL(request.url).searchParams.get('nodeId')?.trim() ?? ''
  // A container hostname is a hex id and reads as noise in the other machine's
  // list; the URL host at least says which address the peer is being added at.
  const machine = hostname()
  const fallback = /^[0-9a-f]{12,}$/i.test(machine) ? new URL(url).host : machine
  const nodeId = asked !== '' ? asked : (fallback || new URL(url).host)
  let secret = control.secret()
  if (secret === '') {
    secret = mintSecret()
    control.setSecret(secret)
  }
  const payload: PairPayload = { v: PAIR_PAYLOAD_VERSION, nodeId, url, secret }
  const token = encodePairToken(payload)
  return jsonResponse({ ok: true, nodeId, url, secret, token, link: url + '/#' + PAIR_PARAM + '=' + token }, 200)
}

/**
 * Import one pairing link: add (or replace) that peer here.
 * @param request - POST with `{ token }` or `{ link }`.
 * @param control - runtime config plus the override file.
 * @returns the peer that was written.
 */
export async function handlePair(request: Request, control: MeshPairControl): Promise<Response> {
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
  const raw = typeof record.token === 'string'
    ? record.token
    : typeof record.link === 'string' ? record.link : ''
  const payload = decodePairToken(raw)
  if ('error' in payload) return jsonResponse({ ok: false, error: payload.error }, 400)

  const existing = [...control.peers()]
  const previous = existing.find(peer => peer.nodeId === payload.nodeId)
  const peer = {
    nodeId: payload.nodeId,
    baseUrl: payload.url,
    // Pairing never carries the login token (it rotates); keep one that is
    // already configured for this node so cookie mode keeps working too.
    token: previous?.token ?? '',
    secret: payload.secret,
  }
  const peers = [...existing.filter(entry => entry.nodeId !== payload.nodeId), peer]
  writeConfigOverride({ peers }, control.file)
  control.runtime.reload?.()
  return jsonResponse({ ok: true, peers, peer }, 200)
}

/** Mount both the link generator and the importer inside the browser fence. */
export function registerMeshPairRoutes(ctx: Context, control: MeshPairControl): void {
  withConnection(ctx, (inner) => {
    const routes: Array<Omit<MeshFetchRoute, 'requestBody'>> = [
      {
        path: MESH_PAIR_LINK_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          try {
            return await handlePairLink(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      },
      {
        path: MESH_PAIR_PATH,
        methods: ['POST'],
        fetch: async (request) => {
          try {
            return await handlePair(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      },
    ]
    const mounted = routes.map(route => mountExactRoute(inner, route))
    return mounted.every(Boolean)
  })
}