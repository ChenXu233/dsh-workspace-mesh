/**
 * Add a remote workspace: choose a machine, walk its directories, register the
 * one you stop in.
 *
 * The workspace is created on the machine that owns the directory -- this Host
 * only relays the call. Nothing is copied, mounted, or turned into a local
 * record here, which is why the dialog never offers a local path.
 */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteTranslate } from './locales'
import { browseRemote, createRemoteWorkspace, useRemoteNodes } from './remote-workspaces'
import type { RemoteBrowseListing } from './remote-workspaces'

export interface RemoteWorkspaceDialogProps {
  open: boolean
  onClose: () => void
  t: RemoteTranslate
}

/** Last path segment, for the default workspace title. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() || path
}

const LIST_HEIGHT = 240

/**
 * The adding flow lives in a dialog so a failed peer never takes the section down.
 * @param props.open - whether the dialog is up.
 * @param props.onClose - dismiss request.
 * @param props.t - this package's translate seat.
 * @returns the dialog element.
 */
export function RemoteWorkspaceDialog({ open, onClose, t }: RemoteWorkspaceDialogProps): JSX.Element {
  const nodes = useRemoteNodes()
  const [nodeId, setNodeId] = useState('')
  const [listing, setListing] = useState<RemoteBrowseListing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Opening resets the walk; a single reachable node is chosen for the user.
  useEffect(() => {
    if (!open) return
    setListing(undefined)
    setError(null)
    setBusy(false)
    setNodeId(current => current !== '' && nodes.some(node => node.nodeId === current)
      ? current
      : (nodes[0]?.nodeId ?? ''))
  }, [open, nodes])

  // Browse the chosen node from its home directory.
  useEffect(() => {
    if (!open || nodeId === '') return
    let cancelled = false
    setBusy(true)
    setError(null)
    browseRemote(nodeId, '')
      .then((next) => { if (!cancelled) setListing(next) })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [open, nodeId])

  const walk = (path: string): void => {
    if (nodeId === '') return
    setBusy(true)
    setError(null)
    browseRemote(nodeId, path)
      .then(setListing)
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const commit = (): void => {
    if (listing === undefined || nodeId === '') return
    setBusy(true)
    setError(null)
    createRemoteWorkspace(nodeId, listing.path, baseName(listing.path))
      .then(() => { onClose() })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  const offline = nodes.length === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('dialog.close')}
      title={t('dialog.title')}
      {...{ description: t('dialog.hint') }}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || listing === undefined} onClick={commit}>{t('dialog.create')}</Button>
        </>
      )}
    >
      {offline ? (
        <div style={MUTED} role="status">{t('dialog.noNodes')}</div>
      ) : (
        <>
          <div style={ROW}>
            <span style={LABEL}>{t('dialog.node')}</span>
            <div style={CHIPS}>
              {nodes.map(node => (
                <button
                  key={node.nodeId}
                  type="button"
                  onClick={() => { setNodeId(node.nodeId) }}
                  aria-pressed={node.nodeId === nodeId}
                  style={node.nodeId === nodeId ? CHIP_ACTIVE : CHIP}
                >
                  {node.label}
                  {node.online ? '' : ' (' + t('offline') + ')'}
                </button>
              ))}
            </div>
          </div>

          <div style={ROW}>
            <span style={LABEL}>{t('dialog.path')}</span>
            <div style={PATH_ROW}>
              <code style={PATH}>{listing?.path ?? '…'}</code>
              <Button
                variant="outline"
                disabled={busy || listing?.parent == null}
                onClick={() => { if (listing?.parent != null) walk(listing.parent) }}
              >
                {t('dialog.up')}
              </Button>
            </div>
          </div>

          <div style={LIST_BOX} role="listbox" aria-busy={busy}>
            {busy && listing === undefined && <div style={MUTED}>{t('dialog.loading')}</div>}
            {listing !== undefined && listing.entries.length === 0 && <div style={MUTED}>{t('dialog.empty')}</div>}
            {listing?.entries.map(entry => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={false}
                style={ENTRY}
                onClick={() => { walk(entry.path) }}
              >
                {entry.name}
              </button>
            ))}
          </div>

          {error !== null && <div style={ERROR} role="alert">{error}</div>}
        </>
      )}
    </Modal>
  )
}

const MUTED: React.CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const ROW: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }
const LABEL: React.CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
const CHIPS: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 }
const CHIP: React.CSSProperties = {
  fontSize: 12, lineHeight: '20px', padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
}
const CHIP_ACTIVE: React.CSSProperties = { ...CHIP, background: 'var(--dsw-alias-interactive-bg-selected, rgba(255,255,255,0.12))' }
const PATH_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const PATH: React.CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)',
}
const LIST_BOX: React.CSSProperties = {
  maxHeight: LIST_HEIGHT, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, padding: 4,
}
const ENTRY: React.CSSProperties = {
  textAlign: 'left', fontSize: 13, lineHeight: '24px', padding: '0 8px', borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'transparent', color: 'inherit',
}
const ERROR: React.CSSProperties = { marginTop: 8, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warning-primary, #d97706)' }
