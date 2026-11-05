import type { Context } from '@deepseek-ai/cordis'
import { buildMeshState } from './state.js'
import type { MeshStateExtras } from './state.js'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import type { MeshToolRuntime } from '../tools/types.js'

export type { MeshFetchBodyMode, MeshFetchRoute, MeshRouteContext } from './mount.js'
export { mountExactRoute, withConnection } from './mount.js'

/** Read-only snapshot endpoint polled by the settings page. */
export const MESH_STATE_PATH = '/api/mesh/state'

/** Extras may be a constant or a getter, so hot-applied values stay fresh. */
export type MeshStateExtrasSource = MeshStateExtras | (() => MeshStateExtras)

function resolveExtras(source: MeshStateExtrasSource): MeshStateExtras {
  return typeof source === 'function' ? source() : source
}

/**
 * Register the state route on a context that already has Connection.
 * @returns whether the route was mounted.
 */
export function mountMeshStateRoute(
  ctx: MeshRouteContext,
  runtime: MeshToolRuntime,
  extras: MeshStateExtrasSource = {},
): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_STATE_PATH,
    methods: ['GET'],
    fetch: async () => {
      try {
        return jsonResponse(await buildMeshState(runtime, Date.now, resolveExtras(extras)))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

/** Serve the settings-page snapshot at /api/mesh/state. */
export function registerMeshStateRoute(
  ctx: Context,
  runtime: MeshToolRuntime,
  extras: MeshStateExtrasSource = {},
): void {
  withConnection(ctx, (inner) => mountMeshStateRoute(inner, runtime, extras))
}
