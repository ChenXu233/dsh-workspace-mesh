import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

/** One Workspace row as the controller publishes it. */
interface WorkspaceRow {
  workspaceId?: string
  id?: string
  title?: string
  path?: string
  sessionIds?: string[]
}
/** The controller snapshot. */
interface WorkspaceSnapshot {
  items?: WorkspaceRow[]
}
/** The observable face of the controller. */
interface WorkspaceListSource {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/**
 * Local Workspaces, drawn from the workspace controller.
 *
 * The shipped browser is a rich entry that proton can feed, but under this kit it
 * re-renders itself without end; a list drawn from the same public snapshot is
 * both honest and stable. This is the local half the shipped browser would have
 * drawn, with the same rows, titles and paths.
 * @param props.source - the controller's list observable.
 * @returns the local group.
 */
export function NativeWorkspaceList({ source }: { source?: WorkspaceListSource | undefined }): ReactNode {
  if (source === undefined) {
    return <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.6 }}>本地工作区不可用</div>
  }
  const snapshot = useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  ) as WorkspaceSnapshot
  const rows = snapshot.items ?? []

  return (
    <div data-native-list="proton" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {rows.length === 0 ? <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.6 }}>还没有本地工作区</div> : null}
      {rows.map(row => (
        <div
          key={row.workspaceId ?? row.path ?? 'unknown'}
          title={row.path}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', fontSize: 13, borderRadius: 6, minWidth: 0 }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title ?? row.path}</span>
        </div>
      ))}
    </div>
  )
}
