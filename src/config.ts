import { CONFIG_ENVELOPE } from './config-envelope.gen.js'

/**
 * Live plugin configuration (official "live configuration forms" convention).
 *
 * The Host discovers an exported `Config` schema on the plugin runtime and:
 * - renders the native settings/plugins form from `Config.toJSON()`
 *   (settings-controller describe → serialized schemastery envelope), and
 * - validates + defaults every profile entry through cordis `resolveConfig`,
 *   which calls `Config["~standard"].validate` and hands the resolved value
 *   to `apply(ctx, config)`.
 *
 * Zero-dependency note (F-12): the schema is authored with @deepseek-ai/schemastery
 * at build time (scripts/gen-config-schema.mjs) and ships only as a serialized
 * envelope; this module rehydrates the two protocol faces without importing it.
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

const TRANSPORT_VALUES = new Set(['auto', 'pairing', 'loopback'])

interface SchemaIssue {
  message: string
  path?: Array<string | number>
}

interface ValidationResult {
  value?: Record<string, unknown>
  issues?: SchemaIssue[]
}

/** Field specs mirrored from scripts/gen-config-schema.mjs (single source of truth lives there). */
const FIELDS = {
  transport: { type: 'enum', values: TRANSPORT_VALUES, fallback: 'auto' },
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
  for (const [key, spec] of Object.entries(FIELDS) as Array<[FieldName, (typeof FIELDS)[FieldName] | undefined]>) {
    if (spec === undefined) continue
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
 * The schema object proper. A plain frozen object exposing exactly the two
 * protocol faces the host reads: `toJSON()` (form rendering) and
 * `~standard.validate` (cordis `resolveConfig`). No schemastery import at
 * runtime; the envelope is build-generated.
 */
export const Config = {
  toJSON: () => CONFIG_ENVELOPE,
  '~standard': {
    validate,
  },
} as const
