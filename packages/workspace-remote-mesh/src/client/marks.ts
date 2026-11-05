import { useSyncExternalStore } from 'react'
import type { SourceMark } from 'dsh-proton-workspace/client'

/** Where one workspace directory came from, as its source reports it. */
export interface WorkspaceMark extends SourceMark {
  /** Id of the source that claimed the directory. */
  readonly sourceId: string
  /** Operator-facing name of that source. */
  readonly sourceLabel: string
}

/**
 * The answer to "where does this directory live", plus the right to say the
 * answer changed. A source that reads a live remote snapshot cannot answer at
 * first paint, so the ledger must be able to wake the rows that asked early.
 */
export interface WorkspaceLedger {
  describe(path: string): WorkspaceMark | undefined
  subscribe(listener: () => void): () => void
}

/** Nothing registered: every row is an ordinary local workspace. */
const emptyLedger: WorkspaceLedger = {
  describe: () => undefined,
  subscribe: () => () => {},
}

let ledger = emptyLedger
let stopLedger: (() => void) | undefined
const listeners = new Set<() => void>()
let version = 0

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getVersion = (): number => version

const changed = (): void => {
  version += 1
  for (const listener of [...listeners]) listener()
}

/**
 * Point the row decoration at the current ledger, and undo that when the fiber
 * owning it goes away.
 *
 * The decoration lives in the vendored renderer, which cannot reach the client
 * context, so the seam is a module singleton rather than a React context: one
 * seat, one ledger, and a store that reads as "nothing to show" while no ledger
 * is installed.
 *
 * @param next - where a directory came from, and when that answer can change.
 * @returns disposer that restores the empty answer.
 */
export function installWorkspaceMarks(next: WorkspaceLedger): () => void {
  ledger = next
  stopLedger = next.subscribe(changed)
  changed()
  return () => {
    // A later install owns the slot now; its disposer restores the empty answer.
    if (ledger !== next) return
    stopLedger?.()
    stopLedger = undefined
    ledger = emptyLedger
    changed()
  }
}

/**
 * Where the workspace at `cwd` lives, re-read when the ledger reports a change.
 * Rows render on every keystroke of the browser's search box, so this must stay
 * a map lookup over state the source already holds.
 *
 * @param cwd - the workspace directory shown by the row.
 * @returns the mark, or undefined for an ordinary local workspace.
 */
export function useWorkspaceMark(cwd: string | undefined): WorkspaceMark | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return cwd === undefined ? undefined : ledger.describe(cwd)
}
