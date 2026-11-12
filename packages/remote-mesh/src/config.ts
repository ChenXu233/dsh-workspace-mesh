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

/** The hub this node joins, if any. */
export interface MeshHubConfig {
  /** Hub origin, e.g. https://hub.example */
  url: string
  /** This node's id in the hub directory; empty = hostname/URL host. */
  nodeId?: string
  /**
   * Secret only the hub operator holds; required to evict a node over the peer
   * API. Members never see it, which is the whole point: membership and
   * administration cannot share one credential.
   */
  adminSecret?: string
  /** Node ids allowed to administer this hub (evict). Their requests must be signed. */
  admins?: string[]
}

export interface MeshPeerConfig {
  /** Node id used by assignment.yml and the tools. */
  nodeId: string
  /** HTTP(S) root of the peer's web host; empty for a hub-only peer. */
  baseUrl: string
  /** Reach this peer through the configured hub (no inbound port on its side). */
  via?: 'hub'
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
  /** Address other machines should use to reach this one; empty = detect. */
  publicUrl?: string
  /** Join this hub: it keeps the directory and relays to nodes without inbound ports. */
  hub?: MeshHubConfig
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
  publicUrl: { type: 'string', fallback: '' },
  assignmentFile: { type: 'string', fallback: '' },
  leaseMs: { type: 'integer', fallback: 900000 },
  dispatchTimeoutMs: { type: 'integer', fallback: 120000 },
  leaseOwner: { type: 'string', fallback: 'mesh-lead' },
} as const

type FieldName = keyof typeof FIELDS

interface PeerEntry {
  nodeId: string
  baseUrl: string
  via?: 'hub'
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
  const keys = ['nodeId', 'baseUrl', 'token', 'secret', 'via'] as const
  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { issue: `"peers[${index}]" must be an object` }
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(keys as readonly string[]).includes(key)) return { issue: `"peers[${index}]" has unknown field "${key}"` }
    }
    const via = record.via
    if (via !== undefined && via !== 'hub') {
      return { issue: `"peers[${index}].via" must be "hub" when present` }
    }
    const nodeId = record.nodeId
    if (typeof nodeId !== 'string' || nodeId.trim() === '') {
      return { issue: `"peers[${index}].nodeId" must be a non-empty string` }
    }
    // A hub-only peer has no address of its own: the hub is the way in.
    const baseUrl = record.baseUrl
    if (typeof baseUrl !== 'string' || (baseUrl.trim() === '' && via !== 'hub')) {
      return { issue: `"peers[${index}].baseUrl" must be a non-empty string unless via is "hub"` }
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
      baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
      ...(via === 'hub' ? { via: 'hub' as const } : {}),
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
  const known = new Set([...Object.keys(FIELDS), 'peers', 'hub'])
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
      // A public address is a URL other machines dial; anything else would
      // produce pairing links that cannot be opened.
      if (key === 'publicUrl' && raw.trim() !== '' && !/^https?:\/\/[^\s]+$/u.test(raw.trim())) {
        return { issues: [{ message: '"publicUrl" must be an http(s) URL or empty', path: [key] }] }
      }
      value[key] = key === 'publicUrl' ? raw.trim().replace(/\/+$/u, '') : raw
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
        return { issues: [{ message: `"${key}" must be a non-negative integer`, path: [key] }] }
      }
      value[key] = raw
    }
  }
  if (source.hub !== undefined) {
    const raw = source.hub
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { issues: [{ message: '"hub" must be an object', path: ['hub'] }] }
    }
    const record = raw as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'url' && key !== 'nodeId' && key !== 'adminSecret' && key !== 'admins') return { issues: [{ message: `"hub" has unknown field "${key}"`, path: ['hub'] }] }
    }
    const url = typeof record.url === 'string' ? record.url.trim().replace(/\/+$/u, '') : ''
    if (url !== '' && !/^https?:\/\/[^\s]+$/u.test(url)) {
      return { issues: [{ message: '"hub.url" must be an http(s) URL', path: ['hub'] }] }
    }
    const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : ''
    const adminSecret = typeof record.adminSecret === 'string' ? record.adminSecret.trim() : ''
    const admins = Array.isArray(record.admins)
      ? (record.admins as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      : []
    value.hub = {
      url,
      ...(nodeId === '' ? {} : { nodeId }),
      ...(adminSecret === '' ? {} : { adminSecret }),
      ...(admins.length === 0 ? {} : { admins }),
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
  publicUrl: { label: '本机对外地址（配对链接用它）; 留空 = 依次用 DSH_PUBLIC_URL、当前页面地址、本机网卡' },
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