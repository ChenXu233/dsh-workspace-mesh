/**
 * Remote rows for the hero workspace picker.
 *
 * The picker is the shipped one; the workspace domain hands it a merged list
 * (see proton-workspace's picker face). This module is the remote side of that
 * merge: it maps the peer projection into picker rows and turns a pick into a
 * dispatch target instead of a local Session.
 *
 * Row ids are prefixed so a pick can never be mistaken for a local Workspace id;
 * the menu label carries the machine because the shipped row has no second cell
 * for it (the sidebar row spells the machine as a suffix instead).
 */
import { currentDispatchTarget, setDispatchTarget } from './dispatch-target'
import { remoteWorkspaceSource } from './remote-workspaces'
import type { RemoteWorkspaceRow } from './remote-workspaces'

/** Namespace of a row that lives on another machine. */
export const REMOTE_ROW_PREFIX = 'remote:'

/** One extra row in the picker menu (shape of the domain's `PickerRow`). */
export interface RemotePickerRow {
  readonly workspaceId: string
  readonly title: string
  /** Canonical path on the peer; the shipped picker uses it to tell same-titled rows apart. */
  readonly path: string
}

/** What the workspace domain accepts as picker extras. */
export interface RemotePickerExtras {
  readonly rows: {
    getSnapshot(): readonly RemotePickerRow[]
    subscribe(listener: () => void): () => void
  }
  pick(workspaceId: string): boolean
  selectedId?(): string | undefined
}

/** Last path segment, for a Workspace the peer published without a title. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() || path
}

/**
 * Stable row id for one remote Workspace.
 * @param row - the projected Workspace.
 * @returns the synthetic id the picker shows and returns.
 */
export function remoteRowId(row: RemoteWorkspaceRow): string {
  return REMOTE_ROW_PREFIX + row.nodeId + ':' + row.workspaceId
}

let cachedSource: readonly RemoteWorkspaceRow[] | undefined
let cachedRows: readonly RemotePickerRow[] = []

/** Rows in the peer's order; rebuilt only when the projection object changes. */
function pickerRows(): readonly RemotePickerRow[] {
  const source = remoteWorkspaceSource.getSnapshot()
  if (source === cachedSource) return cachedRows
  cachedSource = source
  cachedRows = source.map(row => ({
    workspaceId: remoteRowId(row),
    title: `${row.title === '' ? baseName(row.remotePath) : row.title} @${row.nodeLabel}`,
    path: row.remotePath,
  }))
  return cachedRows
}

/**
 * Build the extras object the workspace domain merges into the picker.
 * @returns rows, pick handling, and the current selection.
 */
export function createRemotePickerExtras(): RemotePickerExtras {
  return {
    rows: { getSnapshot: pickerRows, subscribe: remoteWorkspaceSource.subscribe },
    pick: (workspaceId: string): boolean => {
      if (!workspaceId.startsWith(REMOTE_ROW_PREFIX)) return false
      const row = remoteWorkspaceSource.getSnapshot().find(candidate => remoteRowId(candidate) === workspaceId)
      if (row !== undefined) {
        setDispatchTarget({
          nodeId: row.nodeId,
          nodeLabel: row.nodeLabel,
          workspaceId: row.workspaceId,
          title: row.title === '' ? baseName(row.remotePath) : row.title,
          remotePath: row.remotePath,
          online: row.online,
        })
      }
      // A remote id is never a local Workspace: claiming it keeps the picker
      // from asking the Host for a Session it cannot create.
      return true
    },
    selectedId: (): string | undefined => {
      const target = currentDispatchTarget()
      return target === undefined ? undefined : REMOTE_ROW_PREFIX + target.nodeId + ':' + target.workspaceId
    },
  }
}
