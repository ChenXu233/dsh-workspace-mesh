import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Mesh credentials: a shared secret turns into short-lived bearer tokens.
 *
 * Why this exists: the only cross-machine door DSH offers today is the web login
 * token, and that rotates on every peer restart — so a caller has to be handed a
 * new one by a human each time. A shared secret that both sides already hold
 * removes that: the caller asks for a token, the peer mints one, and both sides
 * can re-derive it after any restart without operator input.
 *
 * Scope: the token authorizes exactly one route (`/api/mesh/relay`), never the
 * core `/api` surface. That keeps the blast radius to "what the mesh can do",
 * not "everything the owner can do".
 */

/** Tokens live 10 minutes; the caller renews on demand. */
export const MESH_TOKEN_TTL_MS = 10 * 60 * 1000
/** Clock skew allowed when verifying a handshake timestamp. */
export const MESH_HANDSHAKE_WINDOW_MS = 60 * 1000

export interface MeshTokenClaims {
  /** Node the token was minted for (the caller). */
  nodeId: string
  /** Unix milliseconds after which the token is refused. */
  expiresAt: number
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** `<payload>.<signature>`, both base64url. */
export function mintMeshToken(secret: string, claims: MeshTokenClaims): string {
  const payload = base64url(JSON.stringify(claims))
  return `${payload}.${hmac(secret, payload)}`
}

export type MeshTokenCheck =
  | { ok: true; claims: MeshTokenClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

export function verifyMeshToken(secret: string, token: unknown, now: number = Date.now()): MeshTokenCheck {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
  const [payload, signature] = token.split('.')
  if (payload === undefined || signature === undefined) return { ok: false, reason: 'malformed' }
  if (!constantTimeEqual(hmac(secret, payload), signature)) return { ok: false, reason: 'signature' }
  let claims: MeshTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MeshTokenClaims
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof claims.nodeId !== 'string' || typeof claims.expiresAt !== 'number') return { ok: false, reason: 'malformed' }
  if (claims.expiresAt <= now) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}

export interface HandshakeRequest {
  nodeId: string
  /** Unix milliseconds, must be close to the verifier's clock. */
  ts: number
  nonce: string
}

export function signHandshake(secret: string, request: HandshakeRequest): string {
  return hmac(secret, `mesh-handshake:${request.nodeId}:${request.ts}:${request.nonce}`)
}

export type HandshakeCheck =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'signature' | 'stale' | 'nonce-reused' }

/** Replay guard: a nonce is honoured once inside the window. */
export class NonceCache {
  private readonly seen = new Map<string, number>()
  constructor(private readonly windowMs: number = MESH_HANDSHAKE_WINDOW_MS) {}

  /** @returns false when this nonce was already used inside the window. */
  claim(nonce: string, now: number = Date.now()): boolean {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
    }
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now + this.windowMs)
    return true
  }
}

export function verifyHandshake(
  secret: string,
  body: unknown,
  nonces: NonceCache,
  now: number = Date.now(),
): HandshakeCheck {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'malformed' }
  const record = body as Record<string, unknown>
  const nodeId = record.nodeId
  const ts = record.ts
  const nonce = record.nonce
  const hmacValue = record.hmac
  if (typeof nodeId !== 'string' || nodeId === '') return { ok: false, reason: 'malformed' }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'malformed' }
  if (typeof nonce !== 'string' || nonce.length < 8) return { ok: false, reason: 'malformed' }
  if (typeof hmacValue !== 'string') return { ok: false, reason: 'malformed' }
  if (Math.abs(now - ts) > MESH_HANDSHAKE_WINDOW_MS) return { ok: false, reason: 'stale' }
  const expected = signHandshake(secret, { nodeId, ts, nonce })
  if (!constantTimeEqual(expected, hmacValue)) return { ok: false, reason: 'signature' }
  if (!nonces.claim(nonce, now)) return { ok: false, reason: 'nonce-reused' }
  return { ok: true }
}
