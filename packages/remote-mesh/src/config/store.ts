import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Plugin-owned configuration overrides.
 *
 * This DSH version's settings document only projects entries rooted directly
 * in the profile's `include` fibre, so a profile-patch mounted entry (the way
 * this deployment mounts mesh) has no namespace and the native settings page
 * cannot edit it. The browser page therefore writes its own override file,
 * which is layered on top of the cordis entry config at apply time:
 *
 *   cordis entry config (profile patch)  ->  $DSH_HOME/mesh-config.json  ->  live config
 *
 * The file is best-effort state, not a service: a missing or malformed file
 * only ever falls back to the entry config.
 */

export interface MeshConfigOverride {
  transport?: 'auto'
  peers?: Array<{ nodeId: string; baseUrl: string; token: string; secret?: string }>
  meshSecret?: string
  assignmentFile?: string
  leaseMs?: number
  dispatchTimeoutMs?: number
  leaseOwner?: string
}

export const MESH_CONFIG_FILE_NAME = 'mesh-config.json'
export const MESH_CONFIG_KEYS = [
  'transport',
  'peers',
  'meshSecret',
  'assignmentFile',
  'leaseMs',
  'dispatchTimeoutMs',
  'leaseOwner',
] as const

const TRANSPORTS: readonly string[] = ['auto']

/** Override file path: explicit, else $DSH_HOME, else ~/.dsh. */
export function meshConfigPath(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const home =
    process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, MESH_CONFIG_FILE_NAME)
}

export interface SanitizeResult {
  value: MeshConfigOverride
  problems: string[]
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** A peer is usable when it carries a login token or a shared secret. */
function tokenOrSecretInvalid(token: unknown, secret: unknown): boolean {
  const hasToken = typeof token === 'string' && token.trim() !== ''
  const hasSecret = typeof secret === 'string' && secret.trim() !== ''
  return !hasToken && !hasSecret
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Validate one untrusted override object; unknown keys and bad types are problems. */
export function sanitizeOverride(raw: unknown): SanitizeResult {
  const problems: string[] = []
  const value: MeshConfigOverride = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value, problems: ['config body must be a JSON object'] }
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const entry = record[key]
    switch (key) {
      case 'transport':
        if (isString(entry) && TRANSPORTS.includes(entry)) value.transport = entry as MeshConfigOverride['transport']
        else problems.push('transport must be auto')
        break
      case 'peers': {
        if (!Array.isArray(entry)) {
          problems.push('peers must be an array')
          break
        }
        const peers: Array<{ nodeId: string; baseUrl: string; token: string; secret?: string }> = []
        let bad = false
        for (let index = 0; index < entry.length; index += 1) {
          const item: unknown = entry[index]
          const record = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined
          const nodeId = record?.nodeId
          const baseUrl = record?.baseUrl
          const token = record?.token
          const secret = record?.secret
          if (typeof nodeId !== 'string' || nodeId.trim() === '') { problems.push(`peers[${index}].nodeId must be a non-empty string`); bad = true; break }
          if (typeof baseUrl !== 'string' || !/^https?:\/\//u.test(baseUrl.trim())) { problems.push(`peers[${index}].baseUrl must start with http:// or https://`); bad = true; break }
          if (tokenOrSecretInvalid(token, secret)) { problems.push(`peers[${index}] needs a token or a secret`); bad = true; break }
          if (secret !== undefined && (typeof secret !== 'string' || secret.trim() === '')) { problems.push(`peers[${index}].secret must be a non-empty string when present`); bad = true; break }
          peers.push({
            nodeId: nodeId.trim(),
            baseUrl: baseUrl.trim(),
            token: typeof token === 'string' ? token.trim() : '',
            ...(typeof secret === 'string' ? { secret: secret.trim() } : {}),
          })
        }
        if (!bad) value.peers = peers
        break
      }
      case 'meshSecret':
        if (!isString(entry)) problems.push('meshSecret must be a string')
        else value.meshSecret = entry.trim()
        break
      case 'assignmentFile':
        if (!isString(entry)) problems.push('assignmentFile must be a string')
        else value.assignmentFile = entry.trim()
        break
      case 'leaseOwner':
        if (!isString(entry) || entry.trim() === '') problems.push('leaseOwner must be a non-empty string')
        else value.leaseOwner = entry.trim()
        break
      case 'leaseMs':
        if (!isNonNegativeInteger(entry)) problems.push('leaseMs must be a non-negative integer')
        else value.leaseMs = entry
        break
      case 'dispatchTimeoutMs':
        if (!isNonNegativeInteger(entry)) problems.push('dispatchTimeoutMs must be a non-negative integer')
        else value.dispatchTimeoutMs = entry
        break
      default:
        problems.push('unknown config key "' + key + '"')
    }
  }
  return { value, problems }
}

/** Read the override file; every failure mode degrades to "no overrides". */
export function readConfigOverride(file: string = meshConfigPath()): MeshConfigOverride {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const sanitized = sanitizeOverride(JSON.parse(text) as unknown)
    if (sanitized.problems.length > 0) {
      console.warn('[mesh] ignoring invalid overrides in ' + file + ': ' + sanitized.problems.join('; '))
      return {}
    }
    return sanitized.value
  } catch (err) {
    console.warn('[mesh] ignoring unreadable overrides in ' + file + ': ' + (err instanceof Error ? err.message : String(err)))
    return {}
  }
}

/** Merge a validated patch into the override file (atomic replace). */
export function writeConfigOverride(
  patch: MeshConfigOverride,
  file: string = meshConfigPath(),
): MeshConfigOverride {
  const merged: MeshConfigOverride = { ...readConfigOverride(file), ...patch }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  writeFileSync(temporary, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  renameSync(temporary, file)
  return merged
}