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
  transport?: 'auto' | 'pairing' | 'loopback'
  peerBaseUrl?: string
  assignmentFile?: string
  leaseMs?: number
  dispatchTimeoutMs?: number
  leaseOwner?: string
}

export const MESH_CONFIG_FILE_NAME = 'mesh-config.json'
export const MESH_CONFIG_KEYS = [
  'transport',
  'peerBaseUrl',
  'assignmentFile',
  'leaseMs',
  'dispatchTimeoutMs',
  'leaseOwner',
] as const

const TRANSPORTS: readonly string[] = ['auto', 'pairing', 'loopback']

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
        else problems.push('transport must be one of auto | pairing | loopback')
        break
      case 'peerBaseUrl':
        if (!isString(entry)) problems.push('peerBaseUrl must be a string')
        else if (entry.trim() !== '' && !/^https?:\/\//u.test(entry.trim())) problems.push('peerBaseUrl must start with http:// or https://')
        else value.peerBaseUrl = entry.trim()
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
