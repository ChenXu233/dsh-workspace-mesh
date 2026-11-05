import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** One anchor the host created for a workspace that lives elsewhere. */
interface AnchorRow {
  path: string
  nodeId: string
  nodeLabel: string
  workspaceId: string
  remoteCwd: string
}

const ANCHORS = '/api/mesh/anchors'

/**
 * Read the anchors this host created. A failure leaves the section empty rather
 * than taking the list down: the shipped list still renders above it.
 * @param signal - aborts the request when the section unmounts.
 * @returns the anchors, or none.
 */
async function readAnchors(signal: AbortSignal): Promise<AnchorRow[]> {
  const response = await fetch(ANCHORS, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
  if (!response.ok) return []
  const payload = (await response.json()) as { anchors?: AnchorRow[] }
  return Array.isArray(payload.anchors) ? payload.anchors : []
}

/**
 * The remote half of the workspace list: one row per anchor, labelled with the
 * machine it lives on and the path that machine serves. Rows are not the
 * shipped ones — an anchor is a local stand-in, and the row has to say so.
 * @param props.classes - class names supplied by the host section.
 * @returns the remote group.
 */
export function RemoteWorkspaceSection(): JSX.Element {
  const [rows, setRows] = useState<AnchorRow[] | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    readAnchors(controller.signal)
      .then((found) => { setRows(found) })
      .catch(() => { setRows([]) })
    return () => { controller.abort() }
  }, [])

  if (rows === undefined) return <div style={EMPTY} aria-busy="true" />
  if (rows.length === 0) {
    return <div style={EMPTY}>还没有远程工作区。在「添加工作区」里选一个远端来源。</div>
  }

  return (
    <div role="tree">
      {rows.map((row) => (
        <div key={row.path} style={ROW} role="treeitem" title={row.remoteCwd}>
          <span style={GLYPH} aria-hidden="true"><IconGlobeOutlineRegular /></span>
          <span style={NAME}>{repositoryName(row.remoteCwd)}</span>
          <span style={MACHINE}>{'@' + (row.nodeLabel || row.nodeId)}</span>
          <span style={PATH}>{row.remoteCwd}</span>
        </div>
      ))}
    </div>
  )
}

// Inline so the section has no stylesheet of its own to load or scope: the
// shipped list owns its typography, this group borrows the same scale.
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', minHeight: 32, borderRadius: 'var(--dsw-radius-md)', color: 'var(--dsw-alias-label-primary)' }
const GLYPH: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 20, flex: 'none', color: 'var(--dsw-alias-state-business-primary)' }
const NAME: CSSProperties = { fontSize: 14, lineHeight: '20px', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
const MACHINE: CSSProperties = { fontSize: 11, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' }
const PATH: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto', minWidth: 0, direction: 'rtl', textAlign: 'left' }
const EMPTY: CSSProperties = { padding: '4px 8px', fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }

/**
 * Last path segment of a remote directory; the anchor title cannot be trusted
 * here because it is a local record's label, not the remote path.
 * @param path - absolute path on the owning machine.
 * @returns the display name.
 */
function repositoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() || path
}
