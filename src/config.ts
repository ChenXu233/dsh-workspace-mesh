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

export interface Config {
  /** auto = pairing when detected, otherwise loopback when peerBaseUrl is set. */
  transport?: 'auto' | 'pairing' | 'loopback'
  /** Peer base URL used by the loopback transport. */
  peerBaseUrl?: string
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

const TRANSPORT_VALUES = new Set(['auto', 'pairing', 'loopback'])

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
  peerBaseUrl: { type: 'string', fallback: '' },
  assignmentFile: { type: 'string', fallback: '' },
  leaseMs: { type: 'integer', fallback: 900000 },
  dispatchTimeoutMs: { type: 'integer', fallback: 120000 },
  leaseOwner: { type: 'string', fallback: 'mesh-lead' },
} as const

type FieldName = keyof typeof FIELDS

function validate(input: unknown): ValidationResult {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'expected an object' }] }
  }
  const source = input as Record<string, unknown>
  const known = new Set(Object.keys(FIELDS))
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
  return { value }
}

/**
 * Schema-face projection hints mirrored from scripts/gen-config-schema.mjs,
 * so the plain fallback stays form-visible: dsh-settings' volatileForm()
 * reads node.type / node.meta.volatile / node.dict.
 */
const HINTS: Record<string, { label: string }> = {
  transport: { label: 'transport: auto = pairing 优先, 回落 loopback(需 peerBaseUrl); 保存后立即生效' },
  peerBaseUrl: { label: 'loopback 传输的对端 DSH 基础 URL; 留空 = 不启用' },
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
