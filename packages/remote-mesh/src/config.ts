import { CONFIG_ENVELOPE } from './config-envelope.gen.js'

/**
 * Live plugin configuration (official "live configuration forms" convention).
 *
 * The Host discovers an exported `Config` schema on the plugin runtime and:
 * - projects the native settings form from its schemastery face
 *   (`meta`/`type`/`dict`/`toJSON`, only `.volatile()` fields become entries),
 * - validates + defaults every profile entry through cordis `resolveConfig`
 *   (`Config["~standard"].validate`), handing the resolved value to `apply`.
 *
 * The schema is authored once in scripts/gen-config-schema.mjs and ships as a
 * serialized envelope. At startup we rehydrate it through the host-side
 * schemastery runtime when available (optional peer, same framework-face
 * category as @deepseek-ai/cordis); otherwise a minimal plain face keeps
 * validation and form rendering working without the dependency.
 */

export interface MeshPeerConfig {
  /** Node id used by assignment.yml and the tools. */
  nodeId: string
  /** HTTP(S) root of the peer's web host. */
  baseUrl: string
  /** The peer's current login token; rotates when the peer restarts. */
  token: string
}

export interface Config {
  /** Reserved for transport selection; 'auto' is the only value until an adapter ships. */
  transport?: 'auto'
  /** Peers reachable over their web API; empty = no cross-machine transport. */
  peers?: MeshPeerConfig[]
  /** Shared secret for peer handshakes; enables self-healing relay mode. */
  meshSecret?: string
  /** Assignment table path (SPEC §5.4), resolved against the host process cwd. */
  assignmentFile?: string
  /** Default lease TTL for a dispatched task. */
  leaseMs?: number
  /** How long mesh_dispatch waits for a final reply before expiring the task. */
  dispatchTimeoutMs?: number
  /** Task board lease owner recorded for dispatches made by these tools. */
  leaseOwner?: string
}

/** A volatile config reference handed to apply() by the loader. */
export interface Volatile<T> {
  get(): T
}

/** Read a config field that may be a volatile reference or a plain value. */
export function readLive<T>(value: Volatile<T> | T | undefined, fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value === 'object' && value !== null && 'get' in (value as Record<string, unknown>)) {
    return (value as Volatile<T>).get()
  }
  return value as T
}

const TRANSPORT_VALUES = new Set(['auto'])

interface SchemaIssue {
  message: string
  path?: Array<string | number>
}

interface ValidationResult {
  value?: unknown
  issues?: SchemaIssue[]
}

/** Field specs mirrored from scripts/gen-config-schema.mjs (single source of truth lives there). */
const FIELDS = {
  transport: { type: 'enum', values: TRANSPORT_VALUES, fallback: 'auto' as const },
  meshSecret: { type: 'string', fallback: '' },
  assignmentFile: { type: 'string', fallback: '' },
  leaseMs: { type: 'integer', fallback: 900000 },
  dispatchTimeoutMs: { type: 'integer', fallback: 120000 },
  leaseOwner: { type: 'string', fallback: 'mesh-lead' },
} as const

type FieldName = keyof typeof FIELDS

interface PeerEntry {
  nodeId: string
  baseUrl: string
  token: string
  /** Per-peer shared secret; a paired peer has one and no login token. */
  secret?: string
}

interface PeerIssue {
  value?: PeerEntry[]
  issue?: string
}

function validatePeers(raw: unknown): PeerIssue {
  if (!Array.isArray(raw)) return { issue: '"peers" must be an array' }
  const value: PeerEntry[] = []
  const keys = ['nodeId', 'baseUrl', 'token', 'secret'] as const
  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { issue: `"peers[${index}]" must be an object` }
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(keys as readonly string[]).includes(key)) return { issue: `"peers[${index}]" has unknown field "${key}"` }
    }
    for (const key of ['nodeId', 'baseUrl'] as const) {
      const field = record[key]
      if (typeof field !== 'string' || field.trim() === '') {
        return { issue: `"peers[${index}].${key}" must be a non-empty string` }
      }
    }
    const token = record.token
    const secret = record.secret
    if (token !== undefined && typeof token !== 'string') {
      return { issue: `"peers[${index}].token" must be a string` }
    }
    if (secret !== undefined && (typeof secret !== 'string' || secret.trim() === '')) {
      return { issue: `"peers[${index}].secret" must be a non-empty string when present` }
    }
    const trimmedToken = typeof token === 'string' ? token : ''
    // A peer is reachable either through the login token (cookie mode) or
    // through a shared secret (relay mode); pairing hands out the latter only.
    if (trimmedToken.trim() === '' && (typeof secret !== 'string' || secret.trim() === '')) {
      return { issue: `"peers[${index}]" needs a token or a secret` }
    }
    value.push({
      nodeId: String(record.nodeId).trim(),
      baseUrl: String(record.baseUrl).trim(),
      token: trimmedToken,
      ...(typeof secret === 'string' ? { secret: secret.trim() } : {}),
    })
  }
  return { value }
}

function validate(input: unknown): ValidationResult {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'expected an object' }] }
  }
  const source = input as Record<string, unknown>
  const known = new Set([...Object.keys(FIELDS), 'peers'])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) return { issues: [{ message: `unknown field "${key}"`, path: [key] }] }
  }
  const value: Record<string, unknown> = {}
  for (const key of Object.keys(FIELDS) as FieldName[]) {
    const spec = FIELDS[key]
    const raw = source[key]
    if (raw === undefined || raw === null) {
      value[key] = spec.fallback
      continue
    }
    if (spec.type === 'enum') {
      if (typeof raw !== 'string' || !spec.values.has(raw)) {
        return { issues: [{ message: `"${key}" must be one of ${[...spec.values].join(' | ')}`, path: [key] }] }
      }
      value[key] = raw
    } else if (spec.type === 'string') {
      if (typeof raw !== 'string') {
        return { issues: [{ message: `"${key}" must be a string`, path: [key] }] }
      }
      value[key] = raw
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
        return { issues: [{ message: `"${key}" must be a non-negative integer`, path: [key] }] }
      }
      value[key] = raw
    }
  }
  if (source.peers !== undefined) {
    const peers = validatePeers(source.peers)
    if (peers.issue !== undefined) return { issues: [{ message: peers.issue, path: ['peers'] }] }
    value.peers = peers.value
  }
  return { value }
}

/**
 * Schema-face projection hints mirrored from scripts/gen-config-schema.mjs,
 * so the plain fallback stays form-visible: dsh-settings' volatileForm()
 * reads node.type / node.meta.volatile / node.dict.
 */
const HINTS: Record<string, { label: string }> = {
  transport: { label: 'transport: 目前只有 auto（尚无跨机传输实现）; 保存后重启生效' },
  meshSecret: { label: '对端握手共享密钥; 配置后走 relay 模式, 不再依赖会轮换的登录 token' },
  assignmentFile: { label: 'assignment.yml 路径, 相对宿主进程 cwd; 留空 = 不加载' },
  leaseMs: { label: '任务租约时长 (毫秒)' },
  dispatchTimeoutMs: { label: 'mesh_dispatch 等待最终回复的超时 (毫秒)' },
  leaseOwner: { label: '任务板租约归属者标识' },
}

/** Plain two-face schema used when the schemastery runtime is unavailable. */
function fallbackSchema(): Record<string, unknown> {
  const dict: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(FIELDS) as Array<[FieldName, (typeof FIELDS)[FieldName] | undefined]>) {
    if (spec === undefined) continue
    dict[key] = {
      type: spec.type === 'enum' ? 'union' : spec.type === 'integer' ? 'number' : 'string',
      meta: { volatile: true, default: spec.fallback, description: HINTS[key]?.label ?? '' },
    }
  }
  return {
    type: 'object',
    meta: {},
    dict,
    toJSON: () => CONFIG_ENVELOPE,
    '~standard': { validate },
  }
}

/**
 * The exported Config schema. Rehydrated schemastery object when the optional
 * peer is resolvable (full native settings-form compatibility), plain face
 * otherwise. Top-level await is safe: the host loads plugins as ESM.
 */
let schema: Record<string, unknown>
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  schema = Schema(CONFIG_ENVELOPE as never) as unknown as Record<string, unknown>
} catch {
  schema = fallbackSchema()
}

export const Config: Record<string, unknown> = schema