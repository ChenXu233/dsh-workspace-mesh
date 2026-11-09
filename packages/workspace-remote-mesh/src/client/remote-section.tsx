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
 *
 * A remote group opens onto the Session summaries its owning machine publishes
 * (the mesh transport already collects them). They are read-only here: the log,
 * the runtime and the working directory stay on that machine, so a row never
 * pretends it could open a local Session. Its hover card names the machine.
 */
import { useEffect, useState } from 'react'
import {
  IconProjectAddOutlineRegular, StateDot, Tooltip, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceBrowserProps } from '../../vendor/ui-workspace/src/client/contract/slots.ts'
import { ProjectRowItem } from '../../vendor/ui-workspace/src/client/rows/Rows.tsx'
import css from '../../vendor/ui-workspace/src/client/rows/Rows.module.css'
import type { GroupNode } from '../../vendor/ui-workspace/src/client/tree.ts'
import type { RemoteTranslate } from './locales'
import { RemoteWorkspaceDialog } from './remote-picker'
import { useRemotePageState } from './remote-session'
import { remoteWorkspaceKey, useRemoteWorkspaces } from './remote-workspaces'
import type { RemoteSessionRow, RemoteWorkspaceRow } from './remote-workspaces'

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
 * Session children are rendered by this section, so the node carries only the
 * count the header's chevron reads.
 * @param row - one Workspace a peer published.
 * @param expanded - whether its Session list is open.
 * @returns the group node for its row.
 */
function groupOf(row: RemoteWorkspaceRow, expanded: boolean): GroupNode {
  return {
    key: remoteWorkspaceKey(row),
    workspaceId: undefined,
    cwd: row.remotePath,
    createdAt: undefined,
    label: row.title === '' ? baseName(row.remotePath) : row.title,
    sessionCount: row.sessionRows.length,
    expanded,
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

/** The shipped browser's compact relative time, in its own dictionary. */
function timeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/**
 * One Session row under a remote group: title, running dot, and last activity.
 * Deliberately not a button — the owning machine holds the Session, so there is
 * nothing this Host could open.
 * @param props.session - the peer's summary.
 * @param props.nodeLabel - machine the Session runs on, for the hover hint.
 * @param props.now - epoch ms for the relative label.
 * @param props.t - this package's translate seat.
 * @param props.rowT - the shipped browser's translate seat.
 * @returns the row element.
 */
function RemoteSessionItem({ session, nodeLabel, now, t, rowT, current = false }: {
  session: RemoteSessionRow
  nodeLabel: string
  now: number
  t: RemoteTranslate
  rowT: RowTranslate
  /** This Session is the conversation the page is showing right now. */
  current?: boolean
}): JSX.Element {
  return (
    <Tooltip label={t('session.remoteHint', { node: nodeLabel })} side="right" delayMs={600}>
      <div
        className={css.sessionRow}
        style={current ? { ...SESSION_ROW, ...CURRENT_ROW } : SESSION_ROW}
        role="treeitem"
        aria-disabled="true"
        aria-current={current ? 'true' : undefined}
        data-remote-session={session.sessionId}
        data-remote-current={current ? '' : undefined}
      >
        <span className={css.slot}>
          {session.busy ? <StateDot state="ongoing" size={10} /> : null}
        </span>
        <span className={css.title}>{session.title === '' ? rowT('session.untitled') : session.title}</span>
        {session.updatedAt > 0 && (
          <span className={css.time}>{timeLabel(session.updatedAt, now, rowT)}</span>
        )}
      </div>
    </Tooltip>
  )
}

/**
 * The row for the conversation this page shows.
 *
 * The peer's own summary is preferred once it has a title; before that (and for
 * a Session the snapshot has not listed yet) the row says it is the current one
 * instead of borrowing the "untitled" placeholder.
 * @param row - the Workspace group the page runs on.
 * @param sessionId - the Session the page shows.
 * @param running - whether the peer is working on it right now.
 * @param t - this package's translate seat.
 * @returns the session row to draw.
 */
function currentRowOf(
  row: RemoteWorkspaceRow,
  sessionId: string,
  running: boolean,
  t: RemoteTranslate,
): RemoteSessionRow {
  const known = row.sessionRows.find(session => session.sessionId === sessionId)
  if (known !== undefined && known.title !== '') return { ...known, busy: running || known.busy }
  return { sessionId, title: t('section.current'), updatedAt: known?.updatedAt ?? 0, busy: running }
}

export interface RemoteSectionProps {
  /** This package's translate seat (section chrome and dialog). */
  t: RemoteTranslate
  /** The shipped browser's translate seat, for the borrowed row component. */
  rowT: RowTranslate
}

/**
 * Draw the remote section: its own header with its own add action, then one row
 * per Workspace a peer owns, each opening onto that Workspace's Sessions.
 * @param props.t - this package's translate seat.
 * @param props.rowT - the shipped namespace seat rows use.
 * @returns the section.
 */
export function RemoteSection({ t, rowT }: RemoteSectionProps): JSX.Element {
  const rows = useRemoteWorkspaces()
  const page = useRemotePageState()
  const [picking, setPicking] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const now = Date.now()
  const activeKey = page.target === undefined
    ? undefined
    : 'remote:' + page.target.nodeId + ':' + page.target.workspaceId

  const toggle = (key: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // The page's own Workspace opens itself: the conversation has to be visible
  // under the Workspace it runs on, without asking the reader to expand it.
  useEffect(() => {
    if (activeKey === undefined) return
    setExpanded((current) => {
      if (current.has(activeKey)) return current
      const next = new Set(current)
      next.add(activeKey)
      return next
    })
  }, [activeKey])

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
        {rows.map((row) => {
          const key = remoteWorkspaceKey(row)
          const open = expanded.has(key)
          const active = key === activeKey
          return (
            <div key={key} style={GROUP}>
              <ProjectRowItem
                group={groupOf(row, open)}
                t={rowT}
                onToggle={() => { toggle(key) }}
                onCreate={() => {}}
              />
              {open && (
                <div role="group" aria-label={row.title === '' ? baseName(row.remotePath) : row.title}>
                  {active && page.sessionId !== undefined ? (
                    <RemoteSessionItem
                      key={page.sessionId}
                      session={currentRowOf(row, page.sessionId, page.running, t)}
                      nodeLabel={row.nodeLabel}
                      now={now}
                      t={t}
                      rowT={rowT}
                      current
                    />
                  ) : null}
                  {row.sessionRows.filter(session => !(active && session.sessionId === page.sessionId)).length === 0 && !(active && page.sessionId !== undefined)
                    ? <div style={EMPTY}>{t('section.noSessions')}</div>
                    : row.sessionRows
                      .filter(session => !(active && session.sessionId === page.sessionId))
                      .map(session => (
                        <RemoteSessionItem
                          key={session.sessionId}
                          session={session}
                          nodeLabel={row.nodeLabel}
                          now={now}
                          t={t}
                          rowT={rowT}
                        />
                      ))}
                </div>
              )}
            </div>
          )
        })}
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
const GROUP: React.CSSProperties = { display: 'flex', flexDirection: 'column' }
/** The conversation this page shows: same row, marked as the current one. */
const CURRENT_ROW: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-selection, rgba(120, 120, 120, 0.12))',
  borderRadius: 'var(--dsw-radius-sm)',
  fontWeight: 600,
  cursor: 'default',
}
/** Same 32px row as the shipped list, indented under its group. */
const SESSION_ROW: React.CSSProperties = { paddingInlineStart: 30, cursor: 'default' }
const EMPTY: React.CSSProperties = {
  paddingInlineStart: 30, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)',
}