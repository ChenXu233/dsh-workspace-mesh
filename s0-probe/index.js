/**
 * S0 probe (temporary, both nodes): answer U6/U7/U8 from docs/roadmap.md §8.
 *
 * U6  Can a host-side plugin mint its own Peer and drive typertGateway.invoke?
 * U7  Does a non-owner principal ('mesh-peer') pass remoteAccess for a real
 *     endpoint (session/list) once a policy allows it — and what resource
 *     shape does the gateway demand?
 * U8  Which principal.kind values are actually honored (creator-fixed)?
 *
 * Zero runtime dependencies (repo discipline). Node 22 global fetch only.
 * Cross-machine leg: POST /api/<endpoint> with the owner API cookie obtained
 * from GET /connect?token=...&interactions=none (302 + Set-Cookie).
 */

export const name = 'dsh-s0-probe'
export const inject = ['tools', 'connection', 'remoteAccess', 'typertGateway']

/** Closure state reused across tool runs. */
const state = {
  policyHandle: undefined,
  introspected: undefined,
  local: undefined,
  cross: undefined,
}

function allowAllPolicy() {
  return {
    describe: () => 'S0 probe mesh-peer policy',
    bindings: () => [{
      resource: state.introspected?.resource ?? { kind: 'unknown', id: 'unknown' },
      role: { actions: [state.introspected?.action ?? 'session/list'] },
    }],
    explain: (request) => JSON.stringify({
      U8_principal: request.principal,
      action: request.action,
      resources: request.resources,
      args: request.args,
    }).slice(0, 900),
  }
}

function selfPeer(kind) {
  const conn = ctxConnection()
  return conn.createPeer({ principal: { kind, label: 's0-probe' } })
}
let ctxRef
function ctxConnection() { return ctxRef.connection }

async function invokeEndpoint(endpoint, args, peer) {
  return ctxRef.typertGateway.invoke({ peer, endpoint, args })
}

export function apply(ctx) {
  ctxRef = ctx

  ctx.effect(() => {
    ctx.tools.register({
      name: 'mesh_s0_probe',
      description: 'S0 spike probe (temporary). Runs U6 (self-minted owner Peer over session/list), U7 (self-minted mesh-peer Peer: denial without policy, allowed-with-resource-shape after introspecting policy), U8 (principal kinds honored). Optional args {targetUrl, token} additionally run the cross-machine leg: GET /connect to mint an owner cookie, then POST /api/session/list on the remote node. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          targetUrl: { type: 'string', description: 'Remote node base URL for the cross-machine leg, e.g. http://host:3211' },
          token: { type: 'string', description: 'Launch token of the remote node (from its boot log /connect URL)' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (value) => ({ type: 'json', value }) },
      async execute(args = {}) {
        const report = { local: {}, cross: undefined }
        const { connection, typertGateway } = ctx

        // ---- U6: self-minted OWNER peer against a real endpoint ----
        try {
          if (typeof connection.createPeer !== 'function') throw new Error('connection.createPeer is not exposed')
          const peer = connection.createPeer({ principal: { kind: 'owner', label: 's0-probe' } })
          const value = await typertGateway.invoke({ peer, endpoint: 'session/list', args: {} })
          report.local.U6_ownerPeer_sessionList = { ok: true, preview: JSON.stringify(value).slice(0, 300) }
        } catch (err) {
          report.local.U6_ownerPeer_sessionList = { ok: false, error: String((err && err.message) || err) }
        }

        // ---- U7 step 1: mesh-peer WITHOUT policy -> expect remote-access denied ----
        try {
          const peer = connection.createPeer({ principal: { kind: 'mesh-peer', label: 's0-probe' } })
          const value = await typertGateway.invoke({ peer, endpoint: 'session/list', args: {} })
          report.local.U7_meshpeer_noPolicy = { ok: true, unexpected: 'allowed without any policy', preview: JSON.stringify(value).slice(0, 200) }
        } catch (err) {
          report.local.U7_meshpeer_noPolicy = { denied: true, error: String((err && err.message) || err) }
        }

        // ---- U7 step 2: with policy. First run introspects resource shape via explain(); second allow. ----
        try {
          if (state.policyHandle === undefined) state.policyHandle = ctx.remoteAccess.registerPolicy('mesh-peer', allowAllPolicy())
          const peer = connection.createPeer({ principal: { kind: 'mesh-peer', label: 's0-probe' } })
          const value = await typertGateway.invoke({ peer, endpoint: 'session/list', args: {} })
          report.local.U7_meshpeer_withPolicy = { ok: true, usedResource: state.introspected ?? 'wildcard-first-try', preview: JSON.stringify(value).slice(0, 300) }
        } catch (err) {
          const message = String((err && err.message) || err)
          report.local.U7_meshpeer_withPolicy = { denied: true, error: message }
          // explain() refusal text carries the request JSON; capture for the next run.
          const m = message.match(/\{.*\}/s)
          if (m) {
            try {
              const parsed = JSON.parse(m[0])
              state.introspected = {
                resource: parsed.resources && parsed.resources[0],
                action: parsed.action,
                principal: parsed.U8_principal,
              }
              report.local.U7_introspected = state.introspected
              report.local.U8_principalSeenByPolicy = parsed.U8_principal
            } catch { /* refusal text was not JSON */ }
          }
        }

        // ---- Cross-machine leg (optional) ----
        if (typeof args.targetUrl === 'string' && args.targetUrl !== '' && typeof args.token === 'string' && args.token !== '') {
          try {
            const base = args.targetUrl.replace(/\/+$/, '')
            const connect = await fetch(base + '/connect?token=' + encodeURIComponent(args.token) + '&interactions=none', { redirect: 'manual' })
            const cookie = connect.headers.getSetCookie ? connect.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') : (connect.headers.get('set-cookie') || '').split(';')[0]
            const rpcId = 's0-' + Date.now()
            const body = { type: 'client-request', rpcId, method: 'session/list', payload: { args: {} } }
            const rpc = await fetch(base + '/api/session/list', {
              method: 'POST',
              headers: { 'content-type': 'application/json', cookie },
              body: JSON.stringify(body),
            })
            const text = await rpc.text()
            report.cross = {
              connectStatus: connect.status,
              cookieObtained: cookie !== '',
              rpcStatus: rpc.status,
              bodyPreview: text.slice(0, 400),
            }
          } catch (err) {
            report.cross = { ok: false, error: String((err && err.message) || err) }
          }
        }

        return report
      },
    })
    console.log('[s0-probe] registered mesh_s0_probe')
  })
}
