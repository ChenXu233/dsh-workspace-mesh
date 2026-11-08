/**
 * The dispatch bar: the target, and the receipts of what was sent there.
 *
 * The input is the shipped composer — its submit asks plugins first, and this
 * package claims it while a target is set (see the composer submit event). So
 * this bar has no textarea of its own: two inputs on one screen was the thing
 * that read as wrong. It keeps the target visible, shows what each submit
 * answered, and offers one click to go back to this machine.
 */
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearDispatchTarget, useDispatchTarget } from './dispatch-target'
import type { DispatchTarget } from './dispatch-target'
import { useDispatchLog } from './dispatch-log'
import type { DispatchExchange } from './dispatch-log'
import type { RemoteTranslate } from './locales'

/**
 * Whether an exchange belongs to the current target.
 * @param exchange - one logged exchange.
 * @param target - current target.
 * @returns true while both name the same Workspace.
 */
function sameTarget(exchange: DispatchExchange, target: DispatchTarget): boolean {
  return exchange.targetId === target.nodeId + ':' + target.workspaceId
}

/**
 * Render the dispatch bar while a remote target is set.
 * @param props.t - this package's translate seat.
 * @returns the bar, or null when this machine is the target.
 */
export function DispatchDock({ t }: { t: RemoteTranslate }): JSX.Element | null {
  const target = useDispatchTarget()
  const log = useDispatchLog()
  if (target === undefined) return null
  const visible = log.filter(exchange => sameTarget(exchange, target))

  return (
    <section style={BAR} data-dispatch-dock={target.nodeId + ':' + target.workspaceId}>
      <header style={HEAD}>
        <IconGlobeOutlineRegular size={14} />
        <span style={TITLE}>{t('dock.title', { node: target.nodeLabel })}</span>
        <code style={PATH}>{target.remotePath}</code>
        <button type="button" style={LINK} onClick={() => { clearDispatchTarget() }}>{t('dock.clear')}</button>
      </header>
      {visible.length === 0
        ? <div style={MUTED}>{t('dock.hint')}</div>
        : (
          <div style={LOG} role="log" aria-live="polite">
            {visible.map(exchange => (
              <div key={exchange.id} style={ROW_BLOCK}>
                <div style={ASK}>{exchange.objective}</div>
                {exchange.busy && <div style={MUTED}>{t('dock.waiting')}</div>}
                {exchange.failure !== undefined && <div style={FAILED}>{exchange.failure}</div>}
                {exchange.reply !== undefined && (
                  exchange.reply.ok
                    ? <div style={REPLY}>{exchange.reply.summary === '' ? t('dock.emptyReply') : exchange.reply.summary}</div>
                    : <div style={FAILED}>{exchange.reply.error === '' ? t('dock.failed', { state: exchange.reply.state }) : exchange.reply.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

const BAR: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, margin: '0 auto 8px', maxWidth: 780, width: '100%',
  padding: '8px 10px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 10,
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.04))',
}
const HEAD: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const TITLE: React.CSSProperties = { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const PATH: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }
const LINK: React.CSSProperties = { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, cursor: 'pointer', padding: 0 }
const LOG: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }
const ROW_BLOCK: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const ASK: React.CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
const REPLY: React.CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' }
const FAILED: React.CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warning-primary, #d97706)', whiteSpace: 'pre-wrap' }
const MUTED: React.CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
