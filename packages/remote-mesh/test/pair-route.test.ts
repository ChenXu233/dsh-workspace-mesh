import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  decodePairToken,
  handlePairAddress,
  MESH_PAIR_ADDRESS_PATH,
  resolvePairAddress,
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
    publicUrl: () => '',
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
    publicUrl: () => '',
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
      publicUrl: () => '',
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
    publicUrl: () => '',
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

test('the three pairing routes mount on one context', () => {
  const routes: MeshFetchRoute[] = []
  const ctx: MeshRouteContext = { get: () => ({ fetch: { register: (route: MeshFetchRoute) => routes.push(route) } }) }
  registerMeshPairRoutes(ctx as never, {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    publicUrl: () => '',
    secret: () => '',
    setSecret: () => {},
  })
  assert.deepEqual(routes.map(route => [route.path, route.methods]), [
    [MESH_PAIR_ADDRESS_PATH, ['GET']],
    [MESH_PAIR_LINK_PATH, ['GET']],
    [MESH_PAIR_PATH, ['POST']],
  ])
})

void registerAgain

test('the link address comes from config, then env, then the page origin', async () => {
  const request = new Request('http://dsh.internal' + MESH_PAIR_LINK_PATH, { headers: { origin: 'https://page.example' } })
  // config wins over everything
  assert.deepEqual(resolvePairAddress(request, { publicUrl: () => 'https://config.example:8443/' }), {
    url: 'https://config.example:8443',
    source: 'config',
  })
  // then DSH_PUBLIC_URL
  const previous = process.env.DSH_PUBLIC_URL
  process.env.DSH_PUBLIC_URL = 'https://env.example'
  try {
    assert.deepEqual(resolvePairAddress(request, { publicUrl: () => '' }), { url: 'https://env.example', source: 'env' })
  } finally {
    if (previous === undefined) delete process.env.DSH_PUBLIC_URL
    else process.env.DSH_PUBLIC_URL = previous
  }
  // then the origin the browser used, when it is routable
  assert.deepEqual(resolvePairAddress(request, { publicUrl: () => '' }), { url: 'https://page.example', source: 'request' })
})

test('a loopback page origin never ends up in the link', () => {
  const loopback = new Request('http://dsh.internal' + MESH_PAIR_LINK_PATH, { headers: { origin: 'http://127.0.0.1:3212' } })
  const resolved = resolvePairAddress(loopback, { publicUrl: () => '' })
  assert.notEqual(resolved.source, 'request')
  if (resolved.source === 'lan') {
    assert.match(resolved.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/)
    assert.equal(resolved.url.includes('127.0.0.1'), false)
  }
})

test('the address probe reports the choice and its alternatives', async () => {
  const request = new Request('http://dsh.internal' + MESH_PAIR_ADDRESS_PATH, { headers: { origin: 'https://page.example' } })
  const response = await handlePairAddress(request, {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    publicUrl: () => 'https://config.example',
    secret: () => '',
    setSecret: () => {},
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.url, 'https://config.example')
  assert.equal(body.source, 'config')
  // config first, the page origin second; a LAN address may follow as a fallback.
  assert.deepEqual(body.candidates.slice(0, 2).map((item: any) => item.source), ['config', 'request'])
})

test('a malformed explicit url is refused instead of guessed', async () => {
  const response = await handlePairLink(get('?url=ftp://nope', { origin: 'https://page.example' }), {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    publicUrl: () => '',
    secret: () => 'mesh-x',
    setSecret: () => {},
  })
  assert.equal(response.status, 400)
})

test('an explicit url overrides the detected one', async () => {
  const response = await handlePairLink(get('?url=http://10.1.2.3:3211', { origin: 'http://127.0.0.1:3212' }), {
    runtime: runtime([]),
    file: '/nonexistent/mesh-config.json',
    peers: () => [],
    publicUrl: () => '',
    secret: () => 'mesh-x',
    setSecret: () => {},
  })
  const body = (await response.json()) as Record<string, any>
  assert.equal(body.url, 'http://10.1.2.3:3211')
  assert.equal(body.source, 'custom')
  assert.match(body.link, /^http:\/\/10\.1\.2\.3:3211\/#mesh-pair=/)
})