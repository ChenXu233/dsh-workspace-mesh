/**
 * Where the next dispatched task goes.
 *
 * The hero workspace picker can offer workspaces that live on another machine.
 * Choosing one must not open a Session here -- there is no local directory and no
 * local log -- so the pick is remembered as a target instead, and the surfaces
 * that dispatch read it.
 *
 * In memory on purpose: a target is a handle on a task about to be sent, not a
 * preference. A reloaded page starts from "this machine".
 */
import { useSyncExternalStore } from 'react'

/** One remote Workspace a dispatch may target. */
export interface DispatchTarget {
  readonly nodeId: string
  readonly nodeLabel: string
  readonly workspaceId: string
  readonly title: string
  readonly remotePath: string
  /** Owner receipt from the last snapshot read; a target can outlive it. */
  readonly online: boolean
}

let target: DispatchTarget | undefined
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Read the current target.
 * @returns the target, or undefined while this machine is the target.
 */
export function currentDispatchTarget(): DispatchTarget | undefined {
  return target
}

/**
 * Remember one remote Workspace as the dispatch target.
 * @param next - the Workspace a picker row named.
 */
export function setDispatchTarget(next: DispatchTarget): void {
  target = next
  changed()
}

/** Forget the target, so the next dispatch would come from this machine again. */
export function clearDispatchTarget(): void {
  if (target === undefined) return
  target = undefined
  changed()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = (): DispatchTarget | undefined => target

/**
 * The current target, as React state.
 * @returns the target, or undefined.
 */
export function useDispatchTarget(): DispatchTarget | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
