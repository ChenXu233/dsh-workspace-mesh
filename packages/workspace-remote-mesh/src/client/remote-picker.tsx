/**
 * Add a remote workspace: browse a machine's folders with the shipped dialog,
 * then register the folder you stop in.
 *
 * The dialog is the official one (`ui-directory-picker-browse`, vendored
 * unmodified): it owns the Miller columns, the breadcrumb trail, path editing,
 * "new folder" and the hidden-files toggle. This file supplies the two wire
 * calls — both aimed at the machine that will own the workspace — and turns a
 * confirmed directory into `workspace-create` there. Nothing is copied,
 * mounted, or recorded locally.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { DirectoryBrowser } from '../../vendor/ui-directory-picker-browse/src/client/DirectoryBrowser'
import type { RemoteTranslate } from './locales'
import { browseRemote, createRemoteWorkspace, mkdirRemote, useRemoteNodes, useRemoteWorkspaces } from './remote-workspaces'

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

/**
 * The directory one level above a path, or undefined at a root.
 * @param path - absolute path on the peer.
 * @returns its parent, when there is one.
 */
function parentOf(path: string): string | undefined {
  const cleaned = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  if (cut <= 0) return undefined
  return cleaned.slice(0, cut)
}

/**
 * The adding flow lives in a dialog so a failed peer never takes the section down.
 * @param props.open - whether the dialog is up.
 * @param props.onClose - dismiss request.
 * @param props.t - this package's translate seat.
 * @returns the dialog element.
 */
export function RemoteWorkspaceDialog({ open, onClose, t }: RemoteWorkspaceDialogProps): JSX.Element {
  const nodes = useRemoteNodes()
  const workspaces = useRemoteWorkspaces()
  const [nodeId, setNodeId] = useState('')
  /** Several machines: the owner is picked before the browser opens. */
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Opening resets the walk; a single reachable node is chosen for the user.
  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    const known = nodeId !== '' && nodes.some(node => node.nodeId === nodeId)
    if (known) return
    setNodeId(nodes[0]?.nodeId ?? '')
    setChoosing(nodes.length > 1)
  }, [open, nodes, nodeId])

  // Where the dialog opens: the folder this machine's workspaces live in, so the
  // first screen already shows the tree the user came for. A container home is
  // often only dot-directories, which the dialog hides by default — opening
  // there would look like an empty folder.
  const startPath = useMemo(() => {
    const row = workspaces.find(candidate => candidate.nodeId === nodeId)
    return row === undefined ? undefined : parentOf(row.remotePath)
  }, [workspaces, nodeId])

  // The two wire calls the shipped dialog drives, pointed at the peer.
  const calls = useMemo(() => ({
    async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
      if (nodeId === '') throw new Error(t('dialog.noNodes'))
      const opening = path === undefined
      const listing = await browseRemote(nodeId, path ?? startPath ?? '')
      if (signal?.aborted === true) throw new Error('aborted')
      return {
        path: listing.path,
        // The dialog roots its trail at "home" and treats a level outside it as
        // a jump target, which splits the view in two on open. When the page
        // starts somewhere more useful than the account home (where this
        // machine's workspaces live), that place is the trail's root.
        home: opening && startPath !== undefined ? listing.path : listing.home,
        crumbs: listing.crumbs.map(crumb => ({ ...crumb })),
        entries: listing.entries.map(entry => ({ ...entry })),
        truncated: listing.truncated,
      }
    },
    async createDirectory(path: string, name: string): Promise<string> {
      return await mkdirRemote(nodeId, path, name)
    },
  }), [nodeId, t, startPath])

  const commit = (path: string): void => {
    if (nodeId === '') return
    setBusy(true)
    setError(null)
    createRemoteWorkspace(nodeId, path, baseName(path))
      .then(() => { onClose() })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }

  if (open && nodes.length === 0) {
    return (
      <Modal open onClose={onClose} closeLabel={t('dialog.close')} title={t('dialog.title')}
        footer={<Button variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>}>
        <div style={MUTED} role="status">{t('dialog.noNodes')}</div>
      </Modal>
    )
  }

  if (open && choosing) {
    return (
      <Modal open onClose={onClose} closeLabel={t('dialog.close')} title={t('dialog.chooseMachine')}
        footer={<Button variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>}>
        <div style={CHIPS}>
          {nodes.map(node => (
            <button
              key={node.nodeId}
              type="button"
              onClick={() => { setNodeId(node.nodeId); setChoosing(false) }}
              aria-pressed={node.nodeId === nodeId}
              style={node.nodeId === nodeId ? CHIP_ACTIVE : CHIP}
            >
              {node.label}
              {node.online ? '' : ' (' + t('offline') + ')'}
            </button>
          ))}
        </div>
      </Modal>
    )
  }

  return (
    <>
      <DirectoryBrowser
        open={open && nodeId !== ''}
        busy={busy}
        listDirectory={calls.listDirectory}
        createDirectory={calls.createDirectory}
        onOpen={commit}
        onClose={onClose}
        t={t as unknown as (key: string, params?: Record<string, unknown>) => string}
      />
      {error === null ? null : (
        <Modal open onClose={() => { setError(null) }} closeLabel={t('dialog.close')}
          title={t('dialog.error')}
          footer={<Button variant="outline" onClick={() => { setError(null) }}>{t('dialog.cancel')}</Button>}>
          <div style={MUTED} role="alert">{error}</div>
        </Modal>
      )}
    </>
  )
}

const MUTED: React.CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }
const CHIPS: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const CHIP: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-secondary, rgba(0, 0, 0, 0.12))',
  borderRadius: 999,
  padding: '4px 12px',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}
const CHIP_ACTIVE: React.CSSProperties = {
  ...CHIP,
  borderColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  color: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
}