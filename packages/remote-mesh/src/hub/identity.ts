/**
 * Node identity: a key pair per machine, and signed requests to prove it.
 *
 * Membership and identity are different problems. The shared `meshSecret` says
 * "you belong to this domain"; it says nothing about *which* node is calling, so
 * any member could sign a token claiming to be any other — which makes an audit
 * trail fiction and makes "admins" unenforceable.
 *
 * So every node keeps its own Ed25519 key pair. The public half is registered
 * with the hub when the node joins (trust on first use), and every request to a
 * hub route is signed over method + path + timestamp + nonce + body digest.
 * The hub verifies against the registered key; a member that does not hold the
 * private key cannot claim that node id, no matter what it puts in a claim.
 */
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Headers a signed hub request carries. */
export const IDENTITY_HEADERS = {
  node: 'x-mesh-node',
  ts: 'x-mesh-ts',
  nonce: 'x-mesh-nonce',
  signature: 'x-mesh-sig',
} as const

/** How far a signed timestamp may drift. */
export const IDENTITY_WINDOW_MS = 60_000

/** One node's key pair, as stored on disk. */
interface StoredKeyPair {
  readonly version: 1
  /** PKCS#8 PEM. */
  readonly privateKey: string
  /** SPKI PEM. */
  readonly publicKey: string
}

/** What the hub keeps for a node. */
export interface RegisterablePublicKey {
  /** SPKI PEM, base64-free so it survives JSON transport as-is. */
  readonly publicKey: string
}

/** A loaded identity. */
export interface NodeIdentity {
  readonly publicKey: string
  /**
   * Sign one request.
   * @param input - node id, method, path and the exact body bytes.
   * @returns the headers to attach.
   */
  headers(input: { nodeId: string, method: string, path: string, body?: string, now?: number, nonce?: string }): Record<string, string>
}

/** Digest a request body for signing (empty body has a stable digest too). */
export function bodyDigest(body?: string): string {
  return createHash('sha256').update(body ?? '', 'utf8').digest('hex')
}

/** The exact string that gets signed. */
export function signingPayload(input: {
  nodeId: string
  ts: number
  nonce: string
  method: string
  path: string
  bodyDigest: string
}): string {
  return [input.nodeId, input.ts, input.nonce, input.method.toUpperCase(), input.path, input.bodyDigest].join('\n')
}

/**
 * Load the key pair at `file`, generating it on first use.
 * @param file - where the PEMs live (a JSON file, 0600-ish by intent).
 * @returns the loaded (or freshly created) pair.
 */
export function loadOrCreateKeyPair(file: string): { publicKey: string; privateKey: string } {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredKeyPair
    if (parsed.version === 1 && typeof parsed.privateKey === 'string' && typeof parsed.publicKey === 'string') {
      // Normalise: the hub stores what the node announced, and a stray trailing
      // newline would make "same key?" comparisons (pin checks) lie.
      return { publicKey: parsed.publicKey.trim(), privateKey: parsed.privateKey.trim() }
    }
  } catch {
    // Missing or unreadable: fall through and mint a fresh pair.
  }
  const pair = generateKeyPairSync('ed25519')
  const stored: StoredKeyPair = {
    version: 1,
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
  return { publicKey: stored.publicKey.trim(), privateKey: stored.privateKey.trim() }
}

/**
 * Wrap a key pair into the identity used by the transport.
 * @param keys - PEMs from {@link loadOrCreateKeyPair}.
 * @returns the identity.
 */
export function createIdentity(keys: { publicKey: string; privateKey: string }): NodeIdentity {
  const key = createPrivateKey(keys.privateKey)
  return {
    publicKey: keys.publicKey,
    headers(input) {
      const ts = input.now ?? Date.now()
      const nonce = input.nonce ?? Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)
      const payload = signingPayload({
        nodeId: input.nodeId,
        ts,
        nonce,
        method: input.method,
        path: input.path,
        bodyDigest: bodyDigest(input.body),
      })
      const signature = sign(null, Buffer.from(payload, 'utf8'), key).toString('base64url')
      return {
        [IDENTITY_HEADERS.node]: input.nodeId,
        [IDENTITY_HEADERS.ts]: String(ts),
        [IDENTITY_HEADERS.nonce]: nonce,
        [IDENTITY_HEADERS.signature]: signature,
      }
    },
  }
}

/** What a hub learns from one signed request. */
export type IdentityCheck =
  | { ok: true; nodeId: string }
  | { ok: false; reason: 'missing' | 'stale' | 'unknown-node' | 'bad-signature' }

/**
 * Verify a signed request against the key registered for that node id.
 * @param input - headers, method, path, body and the registered key lookup.
 * @returns the authenticated node id, or why it was refused.
 */
export function verifySignedRequest(input: {
  headers: Headers
  method: string
  path: string
  body?: string
  publicKeyOf: (nodeId: string) => string | undefined
  now?: number
}): IdentityCheck {
  const nodeId = (input.headers.get(IDENTITY_HEADERS.node) ?? '').trim()
  const ts = Number(input.headers.get(IDENTITY_HEADERS.ts) ?? '')
  const nonce = (input.headers.get(IDENTITY_HEADERS.nonce) ?? '').trim()
  const signature = (input.headers.get(IDENTITY_HEADERS.signature) ?? '').trim()
  if (nodeId === '' || nonce === '' || signature === '' || !Number.isFinite(ts)) return { ok: false, reason: 'missing' }
  const now = input.now ?? Date.now()
  if (Math.abs(now - ts) > IDENTITY_WINDOW_MS) return { ok: false, reason: 'stale' }
  const publicKey = input.publicKeyOf(nodeId)
  if (publicKey === undefined || publicKey === '') return { ok: false, reason: 'unknown-node' }
  const payload = signingPayload({
    nodeId,
    ts,
    nonce,
    method: input.method,
    path: input.path,
    bodyDigest: bodyDigest(input.body),
  })
  try {
    const ok = verify(null, Buffer.from(payload, 'utf8'), createPublicKey(publicKey), Buffer.from(signature, 'base64url'))
    return ok ? { ok: true, nodeId } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'bad-signature' }
  }
}