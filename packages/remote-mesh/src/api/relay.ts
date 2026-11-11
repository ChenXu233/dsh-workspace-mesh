import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantLiveHub } from '../live/assistant.js'
import { verifyMeshToken } from './mesh-auth.js'
import { registerMeshPublicRoute } from './mesh-http.js'
import { sseResponse } from './sse.js'
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

/** The same credential, one open response: live frames pushed instead of polled. */
export const MESH_RELAY_STREAM_PATH = '/api/mesh/relay/stream'

export type MeshRelayOp = 'list' | 'create' | 'prompt' | 'page' | 'workspaces' | 'browse' | 'workspace-create' | 'mkdir' | 'assistant-live'

/** Dictionaries a peer browse may return; a machine never answers with more. */
const MAX_BROWSE_ENTRIES = 500

/** The native workspace registry as this route uses it. */
export interface RelayWorkspaceRegistry {
  list(): readonly unknown[]
  create?(path: string, title?: string): unknown
}

/** One directory listing, as the adding flow consumes it. */
export interface RelayBrowseListing {
  /** Canonical path (realpath), so the caller stores what the owner will store. */
  path: string
  /** Parent directory, or null at a filesystem root. */
  parent: string | null
  /** The owning account's home directory: breadcrumb "Home" roots here. */
  home: string
  /** Ancestors from the filesystem root down to `path`, inclusive; every crumb is a jump target. */
  crumbs: Array<{ name: string, path: string, hidden: boolean }>
  /** Entries cut at the read bound: the level has more children than reported. */
  truncated: boolean
  /** Subdirectories only: a Workspace is a directory, never a file. */
  entries: Array<{ name: string; path: string }>
}

function believe(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * List the directories below one absolute path on this machine.
 *
 * A paired peer may browse here; the answer is directory names and paths only,
 * never file contents. Symlinks are not followed on purpose: the canonical path
 * is what the registry will store, and resolving a link chain here would make
 * the listing disagree with the Workspace it later creates.
 *
 * An empty ask starts at this machine's home directory: the caller cannot know
 * another machine's layout, and the answer names the path it landed on.
 * @param value - the requested absolute path, or empty for the home directory.
 * @returns the canonical directory and its subdirectories.
 */
/**
 * The jump chain from the filesystem root to one directory.
 *
 * The browser dialog renders this as its breadcrumb trail, and every crumb is a
 * click target, so the chain has to be complete rather than "the parent".
 * @param canonical - absolute, already resolved path.
 * @returns root-first crumbs, the listed directory last.
 */
function crumbsOf(canonical: string): Array<{ name: string, path: string, hidden: boolean }> {
  const crumbs: Array<{ name: string, path: string, hidden: boolean }> = []
  let current = canonical
  while (true) {
    const parent = dirname(current)
    // A root crumb carries its full path as the name: nothing would label it.
    // A child of the root drops only the separator (`/data` is "data", not "ata"),
    // which is why the slice depends on where the parent ends.
    const name = parent === current
      ? current
      : current.slice(parent.endsWith('/') ? parent.length : parent.length + 1)
    crumbs.unshift({ name, path: current, hidden: false })
    if (parent === current) break
    current = parent
  }
  return crumbs
}

export async function browseDirectories(value: unknown): Promise<RelayBrowseListing> {
  const asked = typeof value === 'string' ? value.trim() : ''
  const requested = asked === '' ? homedir() : asked
  if (!isAbsolute(requested)) {
    throw believe('browse-invalid', 'path must be an absolute directory path')
  }
  let canonical: string
  try {
    canonical = await fs.realpath(requested)
  } catch {
    throw believe('browse-missing', `directory "${requested}" does not exist on this node`)
  }
  const stats = await fs.stat(canonical).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw believe('browse-invalid', `"${canonical}" is not a directory`)
  }
  const rows = await fs.readdir(canonical, { withFileTypes: true })
  const entries: Array<{ name: string; path: string; hidden: boolean }> = []
  let truncated = false
  for (const row of rows.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!row.isDirectory()) continue
    if (entries.length >= MAX_BROWSE_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: row.name, path: join(canonical, row.name), hidden: row.name.startsWith('.') })
  }
  const parent = dirname(canonical)
  return {
    path: canonical,
    parent: parent === canonical ? null : parent,
    home: homedir(),
    crumbs: crumbsOf(canonical),
    entries,
    truncated,
  }
}

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
  /** Native registry; a peer may create a Workspace here through relay. */
  registry?: () => RelayWorkspaceRegistry | undefined
  /** This Host's retained live Assistant frames; absent on a composition without an Agent. */
  live?: () => AssistantLiveHub | undefined
  now?: () => number
}

const RELAY_OPS: ReadonlySet<string> = new Set<MeshRelayOp>([
  'list', 'create', 'prompt', 'page', 'workspaces', 'browse', 'workspace-create', 'mkdir', 'assistant-live',
])

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
  if (op === 'browse') {
    try {
      return jsonResponse({ ok: true, value: await browseDirectories(args.path) }, 200)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'browse-failed'
      return jsonResponse({ ok: false, code, error: message }, 200)
    }
  }
  if (op === 'mkdir') {
    const parent = typeof args.path === 'string' ? args.path.trim() : ''
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (parent === '' || !isAbsolute(parent)) {
      return jsonResponse({ ok: false, code: 'browse-invalid', error: 'path must be an absolute directory path' }, 200)
    }
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      return jsonResponse({ ok: false, code: 'mkdir-invalid', error: 'name must be a single path segment' }, 200)
    }
    try {
      const base = await fs.realpath(parent)
      const target = join(base, name)
      await fs.mkdir(target)
      return jsonResponse({ ok: true, value: { path: target } }, 200)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return jsonResponse({ ok: false, code: 'mkdir-failed', error: message }, 200)
    }
  }
  if (op === 'assistant-live') {
    const hub = control.live?.()
    if (hub === undefined) {
      return jsonResponse({ ok: false, code: 'unavailable', error: 'this Host does not retain live frames' }, 200)
    }
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    if (sessionId === '') return jsonResponse({ ok: false, error: 'sessionId is required' }, 400)
    const rawSince = args.since
    const since = typeof rawSince === 'number' && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0
    return jsonResponse({ ok: true, value: hub.read(sessionId, since) }, 200)
  }
  if (op === 'workspace-create') {
    const registry = control.registry?.()
    if (registry === undefined || typeof registry.create !== 'function') {
      return jsonResponse({ ok: false, code: 'no-registry', error: 'workspaceRegistry.create is not available in this composition' }, 503)
    }
    const target = typeof args.path === 'string' ? args.path.trim() : ''
    if (target === '' || !isAbsolute(target)) {
      return jsonResponse({ ok: false, code: 'browse-invalid', error: 'path must be an absolute directory path' }, 200)
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    try {
      const created = await registry.create(target, title === '' ? undefined : title)
      return jsonResponse({ ok: true, value: created }, 200)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return jsonResponse({ ok: false, code: 'workspace-create-failed', error: message }, 200)
    }
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

/**
 * Serve one live-frame stream to a peer holding a mesh token.
 *
 * The token travels in the body — this route sits below the browser fence, so
 * the peer never needs the login token that rotates on restart.
 * @param request - JSON body `{ token, op, args }`.
 * @param control - secret, plus this Host's retained frames.
 * @returns an open event stream, or a JSON refusal.
 */
export async function handleRelayStream(request: Request, control: MeshRelayControl): Promise<Response> {
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
  const check = verifyMeshToken(secret, record.token, (control.now ?? Date.now)())
  if (!check.ok) {
    return jsonResponse({ ok: false, error: `mesh token rejected: ${check.reason}` }, 401)
  }
  if (record.op !== 'assistant-live') {
    return jsonResponse({ ok: false, error: 'op must be assistant-live on this route' }, 400)
  }
  const hub = control.live?.()
  if (hub === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'this Host does not retain live frames' }, 200)
  }
  const args = (record.args ?? {}) as Record<string, unknown>
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (sessionId === '') return jsonResponse({ ok: false, error: 'sessionId is required' }, 400)
  const rawSince = args.since
  const since = typeof rawSince === 'number' && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0
  return sseResponse((write) => {
    const initial = hub.read(sessionId, since)
    write({ type: 'frames', revision: initial.revision, frames: initial.frames })
    const off = hub.subscribe(sessionId, (page) => {
      if (page.frames.length > 0) write({ type: 'frames', revision: page.revision, frames: page.frames })
    })
    const ping = setInterval(() => write({ type: 'ping' }), 15_000)
    return () => {
      clearInterval(ping)
      off()
    }
  }, request.signal)
}

/**
 * Mount the stream half of the relay below the browser fence.
 * @param ctx - Host context carrying a web server.
 * @param secret - shared mesh secret; empty disables the route.
 * @param live - this Host's retained live frames.
 * @returns true when the route was mounted.
 */
export function registerMeshRelayStreamRoute(
  ctx: Context,
  secret: () => string | undefined,
  live?: () => AssistantLiveHub | undefined,
): boolean {
  return registerMeshPublicRoute(ctx, MESH_RELAY_STREAM_PATH, (request) => handleRelayStream(request, {
    secret,
    controller: () => undefined,
    ...(live === undefined ? {} : { live }),
  }))
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

export function meshRelayControl(
  source: unknown,
  secret: () => string | undefined,
  workspaces?: () => unknown,
  registry?: () => RelayWorkspaceRegistry | undefined,
  live?: () => AssistantLiveHub | undefined,
): MeshRelayControl {
  return {
    secret,
    controller: () => readSessionController(source),
    ...(workspaces === undefined ? {} : { workspaces }),
    ...(registry === undefined ? {} : { registry }),
    ...(live === undefined ? {} : { live }),
  }
}

export function registerMeshRelayRoute(
  ctx: Context,
  source: unknown,
  secret: () => string | undefined,
  workspaces?: () => unknown,
  registry?: () => RelayWorkspaceRegistry | undefined,
  live?: () => AssistantLiveHub | undefined,
): void {
  const control = meshRelayControl(source, secret, workspaces, registry, live)
  // The mesh token is the credential here, so the route lives below the browser
  // fence and checks the token itself.
  registerMeshPublicRoute(ctx, MESH_RELAY_PATH, (request) => handleRelay(request, control))
}