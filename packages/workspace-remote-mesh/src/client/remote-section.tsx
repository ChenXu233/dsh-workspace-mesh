/**
 * The remote half of the sidebar, as its own section.
 *
 * Proton holds the sidebar seat and renders the shipped workspace browser as the
 * region fallback; this section is one entry of that region, so it renders after
 * the shipped list and owns only its own rows. It never sees the shipped list,
 * never wraps it, and never registers a second workspace browser.
 *
 * Rows are drawn by the shipped browser's own row component (vendor copy), so a
 * remote Workspace looks and behaves like a local one without either list
 * knowing about the other: the row receives a remote mark, and every local-only
 * affordance (drag, rename, delete, new Session) is absent by construction.
 */
import { useState } from 'react'
import { IconProjectAddOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceBrowserProps } from '../../vendor/ui-workspace/src/client/contract/slots.ts'
import { ProjectRowItem } from '../../vendor/ui-workspace/src/client/rows/Rows.tsx'
import type { GroupNode } from '../../vendor/ui-workspace/src/client/tree.ts'
import type { RemoteTranslate } from './locales'
import { RemoteWorkspaceDialog } from './remote-picker'
import { remoteWorkspaceKey, useRemoteWorkspaces } from './remote-workspaces'
import type { RemoteWorkspaceRow } from './remote-workspaces'

/** The shipped browser's translate seat, handed down by the seat owner. */
type RowTranslate = WorkspaceBrowserProps['t']

/** Last path segment; the row title when the peer published none. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() || path
}

/**
 * Project one remote Workspace into the group shape the row component expects:
 * no local id, no creation time, and the machine it lives on as the only owner.
 * @param row - one Workspace a peer published.
 * @returns the group node for its row.
 */
function groupOf(row: RemoteWorkspaceRow): GroupNode {
  return {
    key: remoteWorkspaceKey(row),
    workspaceId: undefined,
    cwd: row.remotePath,
    createdAt: undefined,
    label: row.title === '' ? baseName(row.remotePath) : row.title,
    sessionCount: 0,
    expanded: false,
    containsCurrent: false,
    sessions: [],
    remote: {
      nodeId: row.nodeId,
      nodeLabel: row.nodeLabel,
      workspaceId: row.workspaceId,
      remotePath: row.remotePath,
      online: row.online,
    },
  }
}

export interface RemoteSectionProps {
  /** This package's translate seat (section chrome and dialog). */
  t: RemoteTranslate
  /** The shipped browser's translate seat, for the borrowed row component. */
  rowT: RowTranslate
}

/**
 * Draw the remote section: its own header with its own add action, then one row
 * per Workspace a peer owns.
 * @param props.t - this package's translate seat.
 * @param props.rowT - the shipped namespace seat rows use.
 * @returns the section.
 */
export function RemoteSection({ t, rowT }: RemoteSectionProps): JSX.Element {
  const rows = useRemoteWorkspaces()
  const [picking, setPicking] = useState(false)

  return (
    <section data-remote-section="" style={SECTION}>
      <header style={HEADER}>
        <span style={TITLE}>{t('section.title')}</span>
        <Tooltip label={t('section.add')} side="bottom" delayMs={500}>
          <button type="button" style={ADD} aria-label={t('section.add')} onClick={() => { setPicking(true) }}>
            <IconProjectAddOutlineRegular size={16} />
          </button>
        </Tooltip>
      </header>
      <div role="tree" aria-label={t('section.title')}>
        {rows.map(row => (
          <ProjectRowItem
            key={remoteWorkspaceKey(row)}
            group={groupOf(row)}
            t={rowT}
            onToggle={() => {}}
            onCreate={() => {}}
          />
        ))}
      </div>
      <RemoteWorkspaceDialog open={picking} onClose={() => { setPicking(false) }} t={t} />
    </section>
  )
}

const SECTION: React.CSSProperties = { flex: 'none', display: 'flex', flexDirection: 'column', paddingBottom: 8 }
const HEADER: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, height: 32, padding: '0 8px 0 4px',
  color: 'var(--dsw-alias-label-tertiary)',
}
const TITLE: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12, lineHeight: '20px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
const ADD: React.CSSProperties = {
  flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
  padding: 0, border: 'none', borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
}
