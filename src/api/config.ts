import type { Context } from '@deepseek-ai/cordis'
import { loadAssignmentTable } from '../assignments/index.js'
import { sanitizeOverride, writeConfigOverride } from '../config/store.js'
import type { MeshConfigOverride } from '../config/store.js'
import { buildMeshState } from './state.js'
import type { MeshStateExtras } from './state.js'
import { jsonResponse, mountExactRoute, withConnection } from './mount.js'
import type { MeshFetchRoute, MeshRouteContext } from './mount.js'
import type { MeshToolRuntime } from '../tools/types.js'

/**
 * Browser-writable configuration, served next to the read-only snapshot.
 *
 * Writes land in the plugin's own override file ($DSH_HOME/mesh-config.json)
 * because the native settings document does not project profile-patch mounted
 * entries. Lease fields and the assignment table apply to this process
 * immediately; transport selection and the peer URL need a restart because the
 * transport object is built during plugin apply.
 */

export const MESH_CONFIG_PATH = '/api/mesh/config'

export interface MeshConfigControl {
  /** Live runtime whose config/assignment the save mutates in place. */
  runtime: MeshToolRuntime
  /** Override file the browser writes. */
  file: string
  /** Values reported back with the refreshed snapshot. */
  extras: () => MeshStateExtras
}

/** Fields that take effect without restarting the host process. */
export const HOT_CONFIG_KEYS: readonly string[] = ['leaseMs', 'dispatchTimeoutMs', 'leaseOwner', 'assignmentFile']
/** Fields persisted now but applied by the next plugin apply (container restart). */
export const RESTART_CONFIG_KEYS: readonly string[] = ['transport', 'peerBaseUrl']

/**
 * Validate and persist one config patch, then apply the hot subset.
 * @returns the HTTP reply: 400 for a rejected patch, 200 with the fresh state otherwise.
 */
export async function handleConfigSave(request: Request, control: MeshConfigControl): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ ok: false, error: 'body must be JSON' }, 400)
  }

  const sanitized = sanitizeOverride(body)
  if (sanitized.problems.length > 0) {
    return jsonResponse({ ok: false, error: sanitized.problems.join('; ') }, 400)
  }
  const patch: MeshConfigOverride = sanitized.value
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ ok: false, error: 'no config keys supplied' }, 400)
  }

  // The assignment table is configuration, not an optional dependency: a bad
  // path or a syntax error is rejected here, before anything is persisted.
  let nextAssignment: MeshToolRuntime['assignment'] | undefined
  const assignmentFile = patch.assignmentFile
  if (assignmentFile !== undefined) {
    if (assignmentFile === '') {
      nextAssignment = undefined
    } else {
      try {
        nextAssignment = loadAssignmentTable(assignmentFile)
      } catch (err) {
        return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
      }
    }
  }

  writeConfigOverride(patch, control.file)

  const applied: string[] = []
  const pendingRestart: string[] = []
  const runtimeConfig = control.runtime.config

  if (patch.leaseMs !== undefined) {
    runtimeConfig.leaseMs = patch.leaseMs
    applied.push('leaseMs')
  }
  if (patch.dispatchTimeoutMs !== undefined) {
    runtimeConfig.dispatchTimeoutMs = patch.dispatchTimeoutMs
    applied.push('dispatchTimeoutMs')
  }
  if (patch.leaseOwner !== undefined) {
    runtimeConfig.leaseOwner = patch.leaseOwner
    applied.push('leaseOwner')
  }
  if (assignmentFile !== undefined) {
    control.runtime.assignment = nextAssignment
    applied.push('assignmentFile')
  }
  if (patch.transport !== undefined) {
    // Reported by mesh_status immediately; the transport object is rebuilt on restart.
    runtimeConfig.transportMode = patch.transport
    pendingRestart.push('transport')
  }
  if (patch.peerBaseUrl !== undefined) pendingRestart.push('peerBaseUrl')

  const state = await buildMeshState(control.runtime, Date.now, control.extras())
  return jsonResponse({ ok: true, applied, pendingRestart, state })
}

/** Register POST /api/mesh/config on a Connection-bearing context. */
export function mountMeshConfigRoute(ctx: MeshRouteContext, control: MeshConfigControl): boolean {
  const route: Omit<MeshFetchRoute, 'requestBody'> = {
    path: MESH_CONFIG_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        return await handleConfigSave(request, control)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }
  return mountExactRoute(ctx, route)
}

/** Serve POST /api/mesh/config. */
export function registerMeshConfigRoute(ctx: Context, control: MeshConfigControl): void {
  withConnection(ctx, (inner) => mountMeshConfigRoute(inner, control))
}
