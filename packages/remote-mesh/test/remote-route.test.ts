import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { signHandshake, NonceCache } from '../src/api/mesh-auth.js'
import { handleRelay, MESH_RELAY_PATH } from '../src/api/relay.js'
import type { MeshRelayControl } from '../src/api/relay.js'
import { handleRemote, MESH_REMOTE_PATH } from '../src/api/remote.js'
import type { MeshToolRuntime } from '../src/tools/types.js'

const SECRET = 'shared-secret'
const NOW = 1_000_000

function post(path: string, body: unknown): Request {
  return new Request('http://dsh.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function relayControl(overrides: Partial<MeshRelayControl> = {}): MeshRelayControl {
  return {
    secret: () => SECRET,
    controller: () => undefined,
    now: () => NOW,
    ...overrides,
  }
}

/** A token minted by the handshake path, so the relay accepts the call. */
async function acceptedRequest(op: string, args: unknown): Promise<Request> {
  const { handleHandshake } = await import('../src/api/handshake.js')
  const base = { nodeId: 'peer-a', ts: NOW, nonce: 'nonce-1234' }
  const handshake = await handleHandshake(post('/api/mesh/handshake', {
    ...base,
    hmac: signHandshake(SECRET, base),
  }), { secret: () => SECRET, nonces: new NonceCache(), now: () => NOW })
  const body = (await handshake.json()) as { token: string }
  return post(MESH_RELAY_PATH, { token: body.token, op, args })
}

test('a peer browses directories, never files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-browse-'))
  try {
    await mkdir(join(root, 'b-second'))
    await mkdir(join(root, 'a-first'))
    await writeFile(join(root, 'notes.txt'), 'x')
    const response = await handleRelay(await acceptedRequest('browse', { path: root }), relayControl())
    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      ok: boolean
      value?: { path: string; parent: string | null; entries: Array<{ name: string; path: string }> }
    }
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value?.entries.map((entry) => entry.name), ['a-first', 'b-second'])
    // The answer is the canonical path; Windows hands mkdtemp an 8.3 short form.
    assert.equal(payload.value?.path, await realpath(root))
    // The shipped dialog renders a crumb trail and filters hidden rows: both
    // have to arrive, or opening the browser on a peer shows the wrong tree.
    const listing = payload.value as unknown as {
      home: string
      crumbs: Array<{ name: string; path: string }>
      entries: Array<{ name: string; hidden: boolean }>
      truncated: boolean
    }
    assert.equal(listing.home, await realpath(homedir()))
    assert.equal(listing.crumbs[listing.crumbs.length - 1]?.path, await realpath(root))
    assert.equal(listing.crumbs[0]?.path, listing.crumbs[0]?.name)
    assert.deepEqual(listing.entries.map(entry => entry.hidden), [false, false])
    assert.equal(listing.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty browse path opens this machine home instead of failing', async () => {
  const response = await handleRelay(await acceptedRequest('browse', {}), relayControl())
  assert.equal(response.status, 200)
  const payload = (await response.json()) as { ok: boolean; value?: { path: string } }
  assert.equal(payload.ok, true)
  assert.equal(payload.value?.path, await realpath(homedir()))
})

test('a relative browse path is refused instead of guessed', async () => {
  const response = await handleRelay(await acceptedRequest('browse', { path: 'some/where' }), relayControl())
  const payload = (await response.json()) as { ok: boolean; code?: string }
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'browse-invalid')
})

test('a peer creates a Workspace through the registry it already has', async () => {
  const calls: Array<{ path: string; title?: string }> = []
  const response = await handleRelay(
    await acceptedRequest('workspace-create', { path: '/srv/project', title: 'project' }),
    relayControl({
      registry: () => ({
        list: () => [],
        create: (path: string, title?: string) => {
          calls.push({ path, ...(title === undefined ? {} : { title }) })
          return { id: 'w1', path, title: title ?? 'project', sessionIds: [] }
        },
      }),
    }),
  )
  const payload = (await response.json()) as { ok: boolean; value?: { id?: string } }
  assert.equal(payload.ok, true)
  assert.deepEqual(calls, [{ path: '/srv/project', title: 'project' }])
  assert.equal(payload.value?.id, 'w1')
})

test('a composition without the registry says so instead of pretending', async () => {
  const response = await handleRelay(
    await acceptedRequest('workspace-create', { path: '/srv/project' }),
    relayControl(),
  )
  assert.equal(response.status, 503)
})

function runtimeWith(control: unknown): MeshToolRuntime {
  return { transport: control === undefined ? undefined : { kind: 'typert', control } } as unknown as MeshToolRuntime
}

test('the browser route validates before touching a peer', async () => {
  const method = await handleRemote(new Request('http://dsh.internal' + MESH_REMOTE_PATH), { runtime: runtimeWith(async () => ({})) })
  assert.equal(method.status, 405)
  const noNode = await handleRemote(post(MESH_REMOTE_PATH, { op: 'browse', path: '/' }), { runtime: runtimeWith(async () => ({})) })
  assert.equal(noNode.status, 400)
  const badOp = await handleRemote(post(MESH_REMOTE_PATH, { nodeId: 'a', op: 'rm-rf' }), { runtime: runtimeWith(async () => ({})) })
  assert.equal(badOp.status, 400)
})

test('the browser route refuses a transport without the control capability', async () => {
  const response = await handleRemote(post(MESH_REMOTE_PATH, { nodeId: 'a', op: 'browse', path: '/' }), {
    runtime: runtimeWith(undefined),
  })
  assert.equal(response.status, 503)
})

test('the browser route returns what the peer answered', async () => {
  const seen: Array<{ nodeId: string; op: string; args: Record<string, unknown> }> = []
  const response = await handleRemote(post(MESH_REMOTE_PATH, { nodeId: 'peer-a', op: 'browse', path: '/srv' }), {
    runtime: runtimeWith(async (nodeId: string, op: string, args: Record<string, unknown>) => {
      seen.push({ nodeId, op, args })
      return { path: '/srv', parent: '/', entries: [] }
    }),
  })
  const payload = (await response.json()) as { ok: boolean; value?: { path?: string } }
  assert.equal(payload.ok, true)
  assert.equal(payload.value?.path, '/srv')
  assert.deepEqual(seen, [{ nodeId: 'peer-a', op: 'browse', args: { path: '/srv' } }])
})

test('a peer failure keeps its message instead of becoming a generic error', async () => {
  const response = await handleRemote(post(MESH_REMOTE_PATH, { nodeId: 'peer-a', op: 'workspace-create', path: '/srv/x' }), {
    runtime: runtimeWith(async () => { throw Object.assign(new Error('directory is gone'), { code: 'browse-missing' }) }),
  })
  const payload = (await response.json()) as { ok: boolean; code?: string; error?: string }
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'browse-missing')
  assert.match(payload.error ?? '', /directory is gone/)
})

test('a hidden folder is reported hidden instead of being dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-hidden-'))
  try {
    await mkdir(join(root, '.secret'))
    await mkdir(join(root, 'visible'))
    const response = await handleRelay(await acceptedRequest('browse', { path: root }), relayControl())
    const payload = (await response.json()) as { value?: { entries: Array<{ name: string, hidden: boolean }> } }
    assert.deepEqual(payload.value?.entries.map(entry => [entry.name, entry.hidden]), [
      ['.secret', true],
      ['visible', false],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a peer creates one folder inside a directory it can read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-mkdir-'))
  try {
    const response = await handleRelay(await acceptedRequest('mkdir', { path: root, name: 'fresh' }), relayControl())
    const payload = (await response.json()) as { ok: boolean; value?: { path: string } }
    assert.equal(payload.ok, true)
    assert.equal(payload.value?.path, join(await realpath(root), 'fresh'))
    const listed = await handleRelay(await acceptedRequest('browse', { path: root }), relayControl())
    const listing = (await listed.json()) as { value?: { entries: Array<{ name: string }> } }
    assert.deepEqual(listing.value?.entries.map(entry => entry.name), ['fresh'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('folder names cannot escape their parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-mkdir-bad-'))
  try {
    for (const name of ['', '..', '.', 'nested/path', 'nested\\path']) {
      const response = await handleRelay(await acceptedRequest('mkdir', { path: root, name }), relayControl())
      const payload = (await response.json()) as { ok: boolean; code?: string }
      assert.equal(payload.ok, false, 'name ' + JSON.stringify(name) + ' must be refused')
      assert.equal(payload.code, 'mkdir-invalid')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
