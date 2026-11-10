/**
 * Fold the peer's live Assistant frames into the rows the Chat renderer paints.
 *
 * A durable log records one message when the turn settles. While the model is
 * writing, the owning Host emits dense process-local frames instead; its own
 * browser folds them into client-only rows ordered just after the last durable
 * seq. This module is that fold, running here because the frames come from
 * another machine — the row shape and the ordering rule are the peer's.
 */
/** One live Assistant frame, as the owning machine hands it out. */
export interface LiveFrame {
  readonly type?: string
  readonly revision?: number
  readonly attemptId?: string
  readonly index?: number
  readonly time?: number
  readonly turn?: number
  readonly step?: number
  readonly chunk?: unknown
  readonly outcome?: unknown
}

/** One client-only row: an event the log will later settle. */
export interface LiveEntry {
  readonly type: 'transient'
  readonly event: {
    readonly type: 'assistant/live-chunk'
    readonly seq: number
    readonly time: number
    readonly data: {
      readonly attemptId: string
      readonly turn: number
      readonly step: number
      readonly chunk: unknown
    }
  }
}

/** The fold's memory: which attempt is open and where the next chunk belongs. */
export interface LiveState {
  readonly entries: readonly LiveEntry[]
  /** Highest frame revision already folded. */
  readonly revision: number
  readonly attemptId: string | undefined
  readonly turn: number
  readonly step: number
  /** Index the next chunk must carry; anything else means a frame was lost. */
  readonly nextIndex: number
  /** Chunks folded for the open attempt, used for the synthetic seq. */
  readonly gap: number
  /** Last durable seq the rows are ordered after. */
  readonly cursor: number
}

export const EMPTY_LIVE: LiveState = {
  entries: [],
  revision: 0,
  attemptId: undefined,
  turn: 0,
  step: 0,
  nextIndex: 0,
  gap: 0,
  cursor: 0,
}

/**
 * Fold one batch of frames.
 *
 * Folding stops at the first missing index: a reader that joined mid-attempt has
 * no way to know what the missing chunks said, and a half row would be wrong.
 * @param state - the fold so far.
 * @param frames - frames newer than `state.revision`, oldest first.
 * @param cursor - last durable seq in the loaded window.
 * @returns the next fold; the same object when nothing changed.
 */
export function foldFrames(
  state: LiveState,
  frames: readonly LiveFrame[],
  cursor: number,
): LiveState {
  let next: LiveState = state.cursor === cursor ? state : { ...state, cursor }
  let entries = state.entries as LiveEntry[]
  let changed = next !== state
  let entriesChanged = false
  for (const frame of frames) {
    const revision = typeof frame.revision === 'number' ? frame.revision : 0
    if (revision <= next.revision) continue
    next = { ...next, revision }
    changed = true
    if (frame.type === 'start') {
      entries = []
      entriesChanged = true
      next = {
        ...next,
        attemptId: typeof frame.attemptId === 'string' ? frame.attemptId : undefined,
        turn: typeof frame.turn === 'number' ? frame.turn : 0,
        step: typeof frame.step === 'number' ? frame.step : 0,
        nextIndex: 0,
        gap: 0,
      }
      continue
    }
    if (frame.type === 'chunk') {
      if (next.attemptId === undefined || frame.attemptId !== next.attemptId) continue
      const index = typeof frame.index === 'number' ? frame.index : next.nextIndex
      if (index !== next.nextIndex) {
        // Lost a chunk: keep what is on screen legible and wait for the next
        // attempt, which always starts the fold over.
        entries = []
        entriesChanged = true
        next = { ...next, attemptId: undefined }
        continue
      }
      const gap = next.gap + 1
      next = { ...next, nextIndex: next.nextIndex + 1, gap }
      entriesChanged = true
      entries = [...entries, {
        type: 'transient',
        event: {
          type: 'assistant/live-chunk',
          // Ordered after the last durable seq and before the settlement that
          // will replace these rows (same rule the owning browser uses).
          seq: next.cursor + 1 - 1 / (gap + 1),
          time: typeof frame.time === 'number' ? frame.time : Date.now(),
          data: {
            attemptId: frame.attemptId as string,
            turn: next.turn,
            step: next.step,
            chunk: frame.chunk,
          },
        },
      }]
      continue
    }
    if (frame.type === 'end') {
      const outcome = frame.outcome as { kind?: unknown } | undefined
      if (outcome?.kind === 'abandoned' && entries.length > 0) {
        entries = []
        entriesChanged = true
      }
      next = { ...next, attemptId: undefined }
    }
  }
  if (!changed && !entriesChanged) return state
  return entriesChanged ? { ...next, entries } : next
}

/**
 * Drop every live row, e.g. once the durable message settled the turn.
 * @param state - the fold.
 * @returns the fold without rows; the same object when it had none.
 */
export function dropEntries(state: LiveState): LiveState {
  if (state.entries.length === 0 && state.attemptId === undefined) return state
  return { ...state, entries: [], attemptId: undefined }
}