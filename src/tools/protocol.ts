import type { MeshError, MeshErrorCode } from '../types.js'

/**
 * Translation between transport failures and the mesh error vocabulary, plus the
 * reply collector that turns a `follow()` event stream into one final summary.
 *
 * Event shapes (P2 contract, matching DSH session events):
 * - `assistant/message` with `data.message.content` text blocks feeds the summary
 * - `turn/end` (or `final: true` / `done: true` / `session/idle`) is terminal
 * - `error` / `session/error` / `task/failed` (or an `error` payload on an
 *   error-typed event) is a failure
 * The mock transport scripts these shapes directly, so the P2 path never guesses.
 */

const MESH_ERROR_CODES: ReadonlySet<string> = new Set<MeshErrorCode>([
  'denied',
  'grant-expired',
  'node-offline',
  'scope-violation',
  'tier-not-granted',
  'timeout',
  'remote-failure',
])

export function isMeshErrorCode(value: unknown): value is MeshErrorCode {
  return typeof value === 'string' && MESH_ERROR_CODES.has(value)
}

/** Map an adapter-specific error code onto the SPEC §16 MeshErrorCode vocabulary. */
export function mapErrorCode(rawCode: string | undefined): MeshErrorCode {
  if (isMeshErrorCode(rawCode)) return rawCode
  switch (rawCode) {
    case 'unknown-node':
    case 'offline':
      return 'node-offline'
    case 'unknown-workspace':
    case 'scope':
      return 'scope-violation'
    case 'expired':
    case 'lease-expired':
      return 'grant-expired'
    case 'forbidden':
    case 'unauthorized':
      return 'denied'
    case 'ETIMEDOUT':
    case 'aborted':
      return 'timeout'
    default:
      return 'remote-failure'
  }
}

export function meshErrorFrom(rawCode: string | undefined, message: string): MeshError {
  return { code: mapErrorCode(rawCode), message }
}

/** Normalise anything thrown by a transport or the task board. */
export function toMeshError(err: unknown): MeshError {
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>
    const rawCode = typeof record.code === 'string' ? record.code : undefined
    const message =
      typeof record.message === 'string'
        ? record.message
        : err instanceof Error
          ? err.message
          : String(err)
    return meshErrorFrom(rawCode, message === '' ? 'unknown transport failure' : message)
  }
  const message = typeof err === 'string' ? err : String(err)
  return { code: 'remote-failure', message: message === '' ? 'unknown transport failure' : message }
}

export interface MeshSessionFailure {
  message: string
  code?: string
}

export interface DispatchPromptInput {
  taskId: string
  objective: string
  context?: string
  acceptance?: readonly string[]
}

/** Build the single user message a dispatched task sends to the remote session. */
export function buildDispatchPrompt(input: DispatchPromptInput): string {
  const lines = [`[mesh task ${input.taskId}] ${input.objective}`]
  const context = input.context?.trim()
  if (context !== undefined && context !== '') lines.push('', 'Context:', context)
  if (input.acceptance !== undefined && input.acceptance.length > 0) {
    lines.push('', 'Acceptance criteria:')
    input.acceptance.forEach((criterion, index) => lines.push(`${index + 1}. ${criterion}`))
  }
  return lines.join('\n')
}

export type ReplyOutcome =
  | { kind: 'final'; summary: string; eventCount: number }
  | { kind: 'failure'; failure: MeshSessionFailure; eventCount: number }
  | { kind: 'timeout'; eventCount: number; latestText: string }
  | { kind: 'aborted'; eventCount: number }

export interface ReplySnapshot {
  eventCount: number
  latestText: string
  terminal: boolean
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'turn/end',
  'session/end',
  'session/idle',
  'task/done',
  'task/complete',
  'done',
  'complete',
  'assistant/final',
  'result',
])

const FAILURE_REASON_KINDS: ReadonlySet<string> = new Set(['error', 'failed', 'aborted', 'interrupted', 'timeout', 'cancelled'])

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function eventType(record: JsonRecord): string | undefined {
  const value = record.type ?? record.event ?? record.kind
  return typeof value === 'string' ? value : undefined
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  const joined = parts.join('')
  return joined.trim() === '' ? undefined : joined
}

/** Best-effort assistant text extraction for mock and real DSH session events. */
export function extractAssistantText(event: unknown): string | undefined {
  const record = asRecord(event)
  if (record === undefined) return typeof event === 'string' && event.trim() !== '' ? event : undefined

  for (const key of ['text', 'delta'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const directContent = contentToText(record.content)
  if (directContent !== undefined) return directContent

  const message = asRecord(record.message)
  if (message !== undefined) {
    const text = contentToText(message.content)
    if (text !== undefined) return text
    if (typeof message.text === 'string' && message.text.trim() !== '') return message.text
  }

  const data = asRecord(record.data)
  if (data !== undefined) {
    for (const key of ['text', 'delta'] as const) {
      const value = data[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    const nestedMessage = asRecord(data.message)
    if (nestedMessage !== undefined) {
      const text = contentToText(nestedMessage.content)
      if (text !== undefined) return text
      if (typeof nestedMessage.text === 'string' && nestedMessage.text.trim() !== '') return nestedMessage.text
    }
    const dataContent = contentToText(data.content)
    if (dataContent !== undefined) return dataContent
  }
  return undefined
}

function readFailure(event: unknown): MeshSessionFailure | undefined {
  const record = asRecord(event)
  if (record === undefined) return undefined
  const type = eventType(record)
  const errorValue = record.error
  const errorRecord = asRecord(errorValue)
  const errorType =
    type !== undefined &&
    (type === 'error' || type.endsWith('/error') || type === 'task/failed' || type.endsWith('/failed'))
  const payloadAllowed =
    type === undefined || type === 'error' || type.includes('error') || type.includes('failed') || type.startsWith('session/')
  const hasErrorPayload = payloadAllowed && (errorRecord !== undefined || typeof errorValue === 'string')
  if (!errorType && !hasErrorPayload) return undefined

  const directMessage = typeof record.message === 'string' && record.message.trim() !== '' ? record.message : undefined
  const payloadMessage =
    errorRecord !== undefined && typeof errorRecord.message === 'string' && errorRecord.message.trim() !== ''
      ? errorRecord.message
      : typeof errorValue === 'string' && errorValue.trim() !== ''
        ? errorValue
        : undefined
  const message = directMessage ?? payloadMessage ?? `session reported ${type ?? 'an error'}`
  const code =
    typeof record.code === 'string'
      ? record.code
      : errorRecord !== undefined && typeof errorRecord.code === 'string'
        ? errorRecord.code
        : undefined
  return { message, code }
}

function readTerminalSummary(event: unknown): string | undefined {
  const record = asRecord(event)
  if (record === undefined) return undefined
  if (typeof record.summary === 'string' && record.summary.trim() !== '') return record.summary
  const data = asRecord(record.data)
  if (data !== undefined && typeof data.summary === 'string' && data.summary.trim() !== '') return data.summary
  return undefined
}

function readFailureReason(event: unknown): MeshSessionFailure | undefined {
  const record = asRecord(event)
  if (record === undefined) return undefined
  const data = asRecord(record.data)
  const reason = data === undefined ? undefined : asRecord(data.reason)
  if (reason === undefined) return undefined
  const kind = reason.kind
  if (typeof kind !== 'string' || !FAILURE_REASON_KINDS.has(kind)) return undefined
  const message = typeof reason.message === 'string' && reason.message.trim() !== '' ? reason.message : `turn ended with reason "${kind}"`
  return { message, code: kind === 'timeout' ? 'timeout' : undefined }
}

/** Whether an event closes the turn whose reply the dispatcher is waiting for. */
export function isTerminalEvent(event: unknown): boolean {
  const record = asRecord(event)
  if (record === undefined) return false
  if (record.final === true || record.done === true || record.complete === true) return true
  const type = eventType(record)
  return type !== undefined && TERMINAL_TYPES.has(type)
}

/**
 * Collects one turn's events. `start()` clears anything replayed by the initial
 * `follow()` baseline (SPEC §7.2), so resume cannot mistake old history for the
 * reply to this prompt.
 */
export class ReplyCollector {
  private eventCount = 0
  private texts: string[] = []
  private terminalSummary: string | undefined
  private started = false
  private settled: ReplyOutcome | undefined
  private resolveWait: ((outcome: ReplyOutcome) => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private abortSignal: AbortSignal | undefined
  private abortListener: (() => void) | undefined

  start(): void {
    this.started = true
    this.eventCount = 0
    this.texts = []
    this.terminalSummary = undefined
    this.settled = undefined
  }

  push(event: unknown): void {
    if (!this.started || this.settled !== undefined) return
    this.eventCount += 1

    const failure = readFailure(event) ?? readFailureReason(event)
    if (failure !== undefined) {
      this.complete({ kind: 'failure', failure, eventCount: this.eventCount })
      return
    }

    const text = extractAssistantText(event)
    if (text !== undefined) this.texts.push(text)

    if (isTerminalEvent(event)) {
      this.terminalSummary = readTerminalSummary(event)
      this.complete({ kind: 'final', summary: this.summary(), eventCount: this.eventCount })
    }
  }

  summary(): string {
    if (this.terminalSummary !== undefined) return this.terminalSummary
    return this.texts.at(-1) ?? ''
  }

  latestText(): string {
    return this.texts.at(-1) ?? ''
  }

  snapshot(): ReplySnapshot {
    return { eventCount: this.eventCount, latestText: this.latestText(), terminal: this.settled !== undefined }
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<ReplyOutcome> {
    if (this.settled !== undefined) return Promise.resolve(this.settled)
    return new Promise<ReplyOutcome>((resolve) => {
      this.resolveWait = resolve
      this.timer = setTimeout(() => {
        this.complete({ kind: 'timeout', eventCount: this.eventCount, latestText: this.latestText() })
      }, timeoutMs)
      if (signal !== undefined) {
        if (signal.aborted) {
          this.complete({ kind: 'aborted', eventCount: this.eventCount })
          return
        }
        this.abortSignal = signal
        this.abortListener = () => this.complete({ kind: 'aborted', eventCount: this.eventCount })
        signal.addEventListener('abort', this.abortListener, { once: true })
      }
    })
  }

  dispose(): void {
    this.started = false
    this.clearWaitResources()
    this.resolveWait = undefined
  }

  private complete(outcome: ReplyOutcome): void {
    if (this.settled !== undefined) return
    this.settled = outcome
    const resolve = this.resolveWait
    this.resolveWait = undefined
    this.clearWaitResources()
    resolve?.(outcome)
  }

  private clearWaitResources(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.abortSignal !== undefined && this.abortListener !== undefined) {
      this.abortSignal.removeEventListener('abort', this.abortListener)
      this.abortSignal = undefined
      this.abortListener = undefined
    }
  }
}
