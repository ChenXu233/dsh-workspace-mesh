/**
 * The dispatch log: one entry per submit that was sent to another machine.
 *
 * The composer's own draft is the input now (the seat hands its submit verb to
 * whoever claims it first), so this module is what the bar above the composer
 * shows: what was asked, and what came back. In memory on purpose — the peer
 * owns the conversation; this is a receipt, not a second transcript.
 */
import { useSyncExternalStore } from 'react'
import type { DispatchTarget } from './dispatch-target'
import type { DispatchReply } from './remote-dispatch'

/** One submit that left this machine. */
export interface DispatchExchange {
  readonly id: number
  /** `nodeId:workspaceId` the submit went to. */
  readonly targetId: string
  readonly nodeLabel: string
  readonly objective: string
  readonly busy: boolean
  readonly reply?: DispatchReply
  readonly failure?: string
}

let entries: readonly DispatchExchange[] = []
let sequence = 0
const listeners = new Set<() => void>()

function publish(next: readonly DispatchExchange[]): void {
  entries = next
  for (const listener of [...listeners]) listener()
}

/**
 * Record one submit as in flight.
 * @param target - where it was sent.
 * @param objective - the text the composer held.
 * @returns the exchange id, for settlement.
 */
export function appendExchange(target: DispatchTarget, objective: string): number {
  const id = ++sequence
  publish([...entries, {
    id,
    targetId: target.nodeId + ':' + target.workspaceId,
    nodeLabel: target.nodeLabel,
    objective,
    busy: true,
  }])
  return id
}

/**
 * Settle one exchange.
 * @param id - id returned by {@link appendExchange}.
 * @param outcome - reply or failure.
 */
export function settleExchange(id: number, outcome: { reply?: DispatchReply, failure?: string }): void {
  publish(entries.map(entry => (entry.id === id ? { ...entry, busy: false, ...outcome } : entry)))
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = (): readonly DispatchExchange[] => entries

/**
 * The dispatch log, as React state.
 * @returns entries oldest first.
 */
export function useDispatchLog(): readonly DispatchExchange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
