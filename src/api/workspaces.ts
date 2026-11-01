import type { Context } from '@deepseek-ai/cordis'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'

/**
 * This node's own native workspaces, for peers that want to list them.
 *
 * The mesh does not invent workspace ids: a remote caller must target the id the
 * owning DSH instance already knows, so the owner publishes its registry here and
 * the caller consumes it (see transport/typert.ts). Reading is all this route
 * does — creating or mutating a workspace stays a local, human action.
 */

export const MESH_WORKSPACES_PATH = '/api/mesh/workspaces'

/** Shape of `ctx.workspaceRegistry` entries we depend on. */
export interface RegistryWorkspace {
  id?: unknown
  title?: unknown
  path?: unknown
  sessionIds?: unknown
}

export interface WorkspaceRegistryLike {
  list(): readonly RegistryWorkspace[]
}

export interface MeshWorkspacesPayload {
  ok: true
  workspaces: Array<{ workspaceId: string; title: string; path: string; sessions: number }>
  note?: string
}

export function buildWorkspacesPayload(registry: WorkspaceRegistryLike | undefined): MeshWorkspacesPayload {
  if (registry === undefined) {
    return { ok: true, workspaces: [], note: 'workspaceRegistry is not available in this composition' }
  }
  const items = registry.list() ?? []
  return {
    ok: true,
    workspaces: items.map((item) => ({
      workspaceId: String(item.id ?? ''),
      title: typeof item.title === 'string' ? item.title : '',
      path: typeof item.path === 'string' ? item.path : '',
      sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
    })),
  }
}

/**
 * Read the registry without declaring a hard injection: mesh stays loadable in
 * compositions that do not mount the workspace domain.
 */
export function readWorkspaceRegistry(ctx: unknown): WorkspaceRegistryLike | undefined {
  const candidate = ctx as { get?: (name: string) => unknown; workspaceRegistry?: unknown } | undefined
  if (candidate === undefined || candidate === null) return undefined
  let service: unknown
  try {
    service = typeof candidate.get === 'function' ? candidate.get('workspaceRegistry') : candidate.workspaceRegistry
  } catch {
    return undefined
  }
  if (service === null || typeof service !== 'object') return undefined
  const list = (service as { list?: unknown }).list
  return typeof list === 'function' ? (service as WorkspaceRegistryLike) : undefined
}

export function mountMeshWorkspacesRoute(ctx: MeshRouteContext, registry: () => WorkspaceRegistryLike | undefined): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_WORKSPACES_PATH,
    methods: ['GET'],
    fetch: async () => jsonResponse(buildWorkspacesPayload(registry())),
  }
  return mountExactRoute(ctx, route)
}

export function registerMeshWorkspacesRoute(ctx: Context, source: unknown): void {
  withConnection(ctx, (inner) => mountMeshWorkspacesRoute(inner, () => readWorkspaceRegistry(source)))
}
