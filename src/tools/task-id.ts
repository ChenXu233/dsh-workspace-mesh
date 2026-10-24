import { randomBytes } from 'node:crypto'

/** Crockford base32 alphabet used by ULID (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Generate a ULID-shaped task id (SPEC §5.3: "taskId: ULID") without a
 * dependency: 10 base32 characters of millisecond time followed by 16
 * characters (80 bits) of randomness, 26 characters total.
 */
export function createTaskId(
  now: number = Date.now(),
  random: (size: number) => Uint8Array = randomBytes,
): string {
  let time = Math.floor(now)
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError(`task id timestamp must be a non-negative finite number, got ${now}`)
  }

  const timePart = new Array<string>(10)
  for (let index = 9; index >= 0; index -= 1) {
    timePart[index] = CROCKFORD[time % 32]!
    time = Math.floor(time / 32)
  }

  const bytes = random(10)
  if (bytes.length < 10) throw new Error('createTaskId needs at least 10 random bytes')

  let randomPart = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      randomPart += CROCKFORD[(value >>> (bits - 5)) & 31]!
      bits -= 5
    }
  }

  return timePart.join('') + randomPart.slice(0, 16)
}
