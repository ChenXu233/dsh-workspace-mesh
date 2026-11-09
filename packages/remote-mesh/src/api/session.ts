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
/** One page of a remote session's raw event log; the page assembles the transcript. */
export const MESH_SESSION_EVENTS_PATH = '/api/mesh/session/events'

export async function handleSessionEvents(request: Request, control: MeshSessionControl): Promise<Response> {
  const url = new URL(request.url)
  const nodeId = url.searchParams.get('nodeId') ?? ''
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (nodeId === '' || sessionId === '') {
    return jsonResponse({ ok: false, error: 'nodeId and sessionId are required' }, 400)
  }
  const read = (name: string): number | undefined => {
    const raw = url.searchParams.get(name)
    if (raw === null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const throughSeq = read('throughSeq')
  const beforeSeq = read('beforeSeq')
  const maxMessages = read('maxMessages')
  const transport = control.runtime.transport
  if (transport === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'no transport configured' }, 200)
  }
  if (transport.readEvents === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'the active transport cannot read session events' }, 200)
  }
  try {
    const page = await transport.readEvents(nodeId, sessionId, {
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(maxMessages === undefined ? {} : { maxMessages }),
    })
    return jsonResponse({ ok: true, ...page }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return jsonResponse(code === undefined ? { ok: false, error: message } : { ok: false, code, error: message }, 200)
  }
}

/** Open a Session on the peer's machine inside the picked Workspace. */
export const MESH_SESSION_OPEN_PATH = '/api/mesh/session/open'

/** Send one prompt into a Session that lives on the peer's machine. */
export const MESH_SESSION_PROMPT_PATH = '/api/mesh/session/prompt'

async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

export async function handleSessionOpen(request: Request, control: MeshSessionControl): Promise<Response> {
  const body = await bodyOf(request)
  if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  if (nodeId === '' || workspaceId === '') {
    return jsonResponse({ ok: false, error: 'nodeId and workspaceId are required' }, 400)
  }
  const transport = control.runtime.transport
  if (transport === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'no transport configured' }, 200)
  }
  try {
    const sessionId = await transport.createSession(nodeId, workspaceId)
    return jsonResponse({ ok: true, nodeId, workspaceId, sessionId }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return jsonResponse(code === undefined ? { ok: false, error: message } : { ok: false, code, error: message }, 200)
  }
}

export async function handleSessionPrompt(request: Request, control: MeshSessionControl): Promise<Response> {
  const body = await bodyOf(request)
  if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const text = typeof body.text === 'string' ? body.text : ''
  if (nodeId === '' || sessionId === '' || text.trim() === '') {
    return jsonResponse({ ok: false, error: 'nodeId, sessionId and text are required' }, 400)
  }
  const transport = control.runtime.transport
  if (transport === undefined) {
    return jsonResponse({ ok: false, code: 'unavailable', error: 'no transport configured' }, 200)
  }
  try {
    await transport.prompt(nodeId, sessionId, text)
    return jsonResponse({ ok: true }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
    return jsonResponse(code === undefined ? { ok: false, error: message } : { ok: false, code, error: message }, 200)
  }
}

/** Mount the three page-facing routes on one Connection-bearing context. */
export function registerMeshSessionPageRoutes(ctx: Context, runtime: MeshToolRuntime): void {
  const control: MeshSessionControl = { runtime }
  withConnection(ctx, (inner) => {
    const mounted = [
      mountExactRoute(inner, {
        path: MESH_SESSION_EVENTS_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          try {
            return await handleSessionEvents(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      }),
      mountExactRoute(inner, {
        path: MESH_SESSION_OPEN_PATH,
        methods: ['POST'],
        fetch: async (request) => {
          try {
            return await handleSessionOpen(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      }),
      mountExactRoute(inner, {
        path: MESH_SESSION_PROMPT_PATH,
        methods: ['POST'],
        fetch: async (request) => {
          try {
            return await handleSessionPrompt(request, control)
          } catch (err) {
            return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        },
      }),
    ]
    return mounted.every(Boolean)
  })
}

