import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

/** SPEC §17.3 — one rotation epoch. Must be identical on both peers. */
export const EPOCH_MS = 10 * 60 * 1000

export function epochOf(now: number, epochMs: number = EPOCH_MS): number {
  return Math.floor(now / epochMs)
}

/**
 * Derive the per-epoch session key from the pairing-time ECDH shared secret.
 * The key never crosses the wire; only the epoch index does (and it is public).
 */
export function deriveEpochKey(sharedSecret: Uint8Array, epoch: number): Buffer {
  if (sharedSecret.length < 16) throw new Error('shared secret too short')
  const salt = Buffer.alloc(8)
  salt.writeBigUInt64BE(BigInt(epoch))
  const out = hkdfSync('sha256', sharedSecret, salt, Buffer.from('mesh-v1'), 32)
  return Buffer.from(out)
}

export interface RequestFingerprint {
  requestId: string
  method: string
  bodyHash: string
}

function canonical(fp: RequestFingerprint): string {
  return `${fp.requestId}\n${fp.method}\n${fp.bodyHash}`
}

/** SPEC §17.3 — the "dynamic password": derived, never transmitted. */
export function requestToken(epochKey: Uint8Array, fp: RequestFingerprint, bytes = 16): string {
  return createHmac('sha256', epochKey).update(canonical(fp)).digest().subarray(0, bytes).toString('base64url')
}

export function verifyRequestToken(
  epochKey: Uint8Array,
  fp: RequestFingerprint,
  token: string,
  bytes = 16,
): boolean {
  const expected = Buffer.from(requestToken(epochKey, fp, bytes))
  const actual = Buffer.from(token)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Accepts a token from the current epoch or its immediate neighbours
 * (clock skew tolerance, SPEC §17.3), and rejects replays.
 */
export class ReplayGuard {
  private readonly seen = new Map<number, Set<string>>()
  /** Highest epoch accepted so far — compared against, never folded into, the incoming one. */
  private highest = Number.NEGATIVE_INFINITY

  constructor(private readonly window = 3) {}

  /** Returns true when the request may proceed. */
  accept(epoch: number, requestId: string, tolerance = 1): boolean {
    if (this.highest !== Number.NEGATIVE_INFINITY && Math.abs(epoch - this.highest) > tolerance) {
      return false
    }

    let bucket = this.seen.get(epoch)
    if (!bucket) {
      bucket = new Set<string>()
      this.seen.set(epoch, bucket)
    }
    if (bucket.has(requestId)) return false
    bucket.add(requestId)

    if (epoch > this.highest) this.highest = epoch

    // Drop epochs outside the window so the map cannot grow without bound.
    for (const key of [...this.seen.keys()]) {
      if (key < this.highest - this.window) this.seen.delete(key)
    }
    return true
  }
}
