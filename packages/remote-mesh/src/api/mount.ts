import type { Context } from '@deepseek-ai/cordis'

/**
 * Shared plumbing for the settings page's HTTP surface.
 *
 * The page cannot read mesh state through the settings document (this DSH
 * version's config-editor only exposes entries rooted in the profile's
 * `include` fibre, so a profile-patch mounted entry has no namespace) and it
 * cannot load a Remote controller either (a profile plugin has no resolvable
 * `@deepseek-ai/dsh-typert-protocol` dependency). It can call exact Fetch
 * routes registered inside Connection's authentication fence — the same seat
 * the shipped `/api/present.host` and `/api/changes.summary` routes use.
 *
 * Connection is resolved through a non-blocking injection: mesh stays loadable
 * in headless compositions, and still mounts when Connection starts later in
 * the same boot.
 */

export type MeshFetchBodyMode = 'buffered' | 'streaming'

export interface MeshFetchRoute {
  path: string
  methods: string[]
  requestBody: MeshFetchBodyMode
  fetch: (request: Request) => Response | Promise<Response>
}

/** Minimal Context surface used here, kept duck-typed for unit tests. */
export interface MeshRouteContext {
  get(name: string): unknown
  inject?(deps: string[], callback: (inner: MeshRouteContext) => void): unknown
}

/** Minimal Connection surface used here. */
export interface ConnectionLike {
  fetch?: {
    register(route: MeshFetchRoute): unknown
  }
}

export function asRouteContext(ctx: unknown): MeshRouteContext | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof (ctx as MeshRouteContext).get !== 'function') return undefined
  return ctx as MeshRouteContext
}

export function connectionOf(ctx: MeshRouteContext): ConnectionLike | undefined {
  const service = ctx.get('connection')
  if (service === null || typeof service !== 'object') return undefined
  return service as ConnectionLike
}

/** JSON reply with the cache defeated: the page polls it. */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Run `mount` once Connection is available (immediately when it already is).
 * @returns whether the route was mounted synchronously.
 */
export function withConnection(ctx: Context, mount: (inner: MeshRouteContext) => boolean): boolean {
  const routeCtx = asRouteContext(ctx)
  if (routeCtx === undefined) return false
  const inject = routeCtx.inject
  if (typeof inject !== 'function') return mount(routeCtx)
  let mounted = false
  inject.call(routeCtx, ['connection'], (inner) => {
    const resolved = asRouteContext(inner)
    if (resolved !== undefined) mounted = mount(resolved)
  })
  return mounted
}

/** Register one exact route on a Connection-bearing context. */
export function mountExactRoute(
  ctx: MeshRouteContext,
  route: Omit<MeshFetchRoute, 'requestBody'> & { requestBody?: MeshFetchBodyMode },
): boolean {
  const registrar = connectionOf(ctx)?.fetch
  if (registrar === undefined || typeof registrar.register !== 'function') {
    console.info('[mesh] settings page: no connection.fetch service; ' + route.path + ' is not served')
    return false
  }
  registrar.register({
    path: route.path,
    methods: route.methods,
    requestBody: route.requestBody ?? 'buffered',
    fetch: route.fetch,
  })
  console.info('[mesh] settings page route mounted at ' + route.path)
  return true
}
