import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  decodePairToken,
  encodePairToken,
  handlePair,
  handlePairLink,
  MESH_PAIR_LINK_PATH,
  MESH_PAIR_PATH,
  PAIR_PAYLOAD_VERSION,
  registerMeshPairRoutes,
} from '../src/api/pair.js'
import type { PairPayload } from '../src/api/pair.js'
import { readConfigOverride } from '../src/config/store.js'
import type { MeshFetchRoute, MeshRouteContext } from '../src/api/mount.js'
import { createInMemoryBoard } from '../src/board/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import type { MeshToolConfig, MeshToolRuntime } from '../src/tools/types.js'
import { registerMeshPairRoutes as registerAgain } from '../src/api/pair.js'

/** Pairing carries a URL and a secret; nothing else has to be typed by hand. */

type Peers = Array<{ nodeId: string, baseUrl: string, token: string, secret?: string }>

function runtime(peers: Peers, reload?: () => void): MeshToolRuntime {
  const config: MeshToolConfig = { transportMode: 'auto', leaseMs: 900_000, dispatchTimeoutMs: 5_000, leaseOwner: 'lead' }
  return {
    board: createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    transport: undefined,
    config,
    ...(reload === undefined ? {} : { reload }),
  }
}

function post(body: unknown): Request {
  return new Request('http://dsh.internal' + MESH_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request('http://dsh.internal' + MESH_PAIR_LINK_PATH + url, { method: 'GET', headers })
}

test('a pairing link carries the origin, the node name and the secret', async () => {
  let secret = ''
  const response = await handlePairLink(get('?nodeId=tencent', { origin: 'https://harness.example.cn' }), {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    secret: () => secret,
    setSecret: (next) => { secret = next },
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.ok, true)
  assert.equal(body.url, 'https://harness.example.cn')
  assert.equal(body.nodeId, 'tencent')
  // The payload rides the fragment: the web UI redirects \`/?token=\` to \`/\` and\n  // a query parameter would be dropped before the client could read it.\n  assert.match(body.link, /^https:\/\/harness\.example\.cn\/#mesh-pair=/)
  assert.equal(body.secret, secret)
  const decoded = decodePairToken(body.token)
  assert.equal('error' in decoded, false)
  assert.equal((decoded as PairPayload).secret, secret)
})

test('a node with no secret mints one on the spot', async () => {
  let secret = ''
  await handlePairLink(get('', { referer: 'http://10.0.0.5:3211/settings' }), {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    secret: () => secret,
    setSecret: (next) => { secret = next },
  })
  assert.match(secret, /^mesh-/)
})

test('a token that is not this build\'s payload is refused, not guessed', () => {
  assert.deepEqual(decodePairToken(''), { error: 'pair token is empty' })
  assert.equal('error' in decodePairToken(encodePairToken({ v: 99, nodeId: 'a', url: 'http://a', secret: 's' })), true)
  assert.equal('error' in decodePairToken(encodePairToken({ v: PAIR_PAYLOAD_VERSION, nodeId: 'a', url: 'ftp://a', secret: 's' })), true)
  assert.equal('error' in decodePairToken(encodePairToken({ v: PAIR_PAYLOAD_VERSION, nodeId: 'a', url: 'http://a', secret: '' })), true)
  const whole = 'https://x.example/?mesh-pair=' + encodePairToken({ v: PAIR_PAYLOAD_VERSION, nodeId: 'b', url: 'https://b.example', secret: 'mesh-s' })
  const decoded = decodePairToken(whole)
  assert.equal('error' in decoded, false)
  assert.equal((decoded as PairPayload).nodeId, 'b')
})

test('importing a link writes one peer with its secret and reloads the transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-pair-'))
  const file = join(dir, 'mesh-config.json')
  let reloaded = 0
  const token = encodePairToken({ v: PAIR_PAYLOAD_VERSION, nodeId: 'aliyun', url: 'http://101.1.1.1:3211', secret: 'mesh-shared' })
  try {
    const response = await handlePair(post({ token }), {
      runtime: runtime([{ nodeId: 'aliyun', baseUrl: 'http://old', token: 'login-token' }], () => { reloaded += 1 }),
      file,
      peers: () => [{ nodeId: 'aliyun', baseUrl: 'http://old', token: 'login-token' }],
      secret: () => '',
      setSecret: () => {},
    })
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.ok, true)
    assert.equal(body.peer.baseUrl, 'http://101.1.1.1:3211')
    assert.equal(body.peer.secret, 'mesh-shared')
    // The rotating login token, when one was already configured, is kept.
    assert.equal(body.peer.token, 'login-token')
    assert.equal(reloaded, 1)
    const written = readConfigOverride(file)
    assert.deepEqual(written.peers?.map(peer => [peer.nodeId, peer.secret]), [['aliyun', 'mesh-shared']])
    assert.match(await readFile(file, 'utf8'), /mesh-shared/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second machine is added beside the first instead of replacing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-pair-two-'))
  const file = join(dir, 'mesh-config.json')
  const peers: Peers = [{ nodeId: 'a', baseUrl: 'http://a', token: 't' }]
  const control = {
    runtime: runtime(peers),
    file,
    peers: () => peers,
    secret: () => '',
    setSecret: () => {},
  }
  try {
    const token = encodePairToken({ v: PAIR_PAYLOAD_VERSION, nodeId: 'b', url: 'http://b', secret: 'mesh-b' })
    const response = await handlePair(post({ token }), control)
    const body = (await response.json()) as Record<string, any>
    assert.deepEqual(body.peers.map((peer: any) => peer.nodeId), ['a', 'b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the two pairing routes mount on one context', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  registerMeshPairRoutes(ctx as never, {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    secret: () => '',
    setSecret: () => {},
  })
  assert.deepEqual(routes.map(route => [route.path, route.methods]), [
    [MESH_PAIR_LINK_PATH, ['GET']],
    [MESH_PAIR_PATH, ['POST']],
  ])
})

void registerAgain