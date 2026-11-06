/**
 * The dispatch bar: one objective to the target machine, its reply right here.
 *
 * It renders above the composer instead of replacing it. The composer belongs to
 * the conversation shell; this bar belongs to us, so it can subscribe to the
 * target and re-render the moment a Workspace is picked. The shipped composer
 * keeps its own meaning (it sends to this machine's agent), and the bar says
 * which machine it talks to so the two are not confused.
 */
import { useEffect, useRef, useState } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearDispatchTarget, useDispatchTarget } from './dispatch-target'
import type { DispatchTarget } from './dispatch-target'
import type { RemoteTranslate } from './locales'
import { dispatchToTarget } from './remote-dispatch'
import type { DispatchReply } from './remote-dispatch'

/** One settled or in-flight exchange, kept while the bar is mounted. */
interface Exchange {
  readonly id: number
  /** Target the exchange belongs to (a later pick starts a fresh list). */
  readonly targetId: string
  readonly objective: string
  readonly busy: boolean
  readonly reply?: DispatchReply
  readonly failure?: string
}

/**
 * Whether an exchange belongs to the current target.
 * @param exchange - one logged exchange.
 * @param target - current target, if any.
 * @returns true while both name the same Workspace.
 */
function sameTarget(exchange: Exchange, target: DispatchTarget): boolean {
  return exchange.targetId === target.nodeId + ':' + target.workspaceId
}

/**
 * Render the dispatch bar while a remote target is set.
 * @param props.t - this package's translate seat.
 * @returns the bar, or null when this machine is the target.
 */
export function DispatchDock({ t }: { t: RemoteTranslate }): JSX.Element | null {
  const target = useDispatchTarget()
  const [draft, setDraft] = useState('')
  const [exchanges, setExchanges] = useState<readonly Exchange[]>([])
  const seq = useRef(0)

  // A different Workspace is a different conversation: the draft belongs to the
  // one that was picked, not to whatever replaces it.
  useEffect(() => { setDraft('') }, [target?.nodeId, target?.workspaceId])

  if (target === undefined) return null
  const targetId = target.nodeId + ':' + target.workspaceId
  const visible = exchanges.filter(exchange => exchange.targetId === targetId)
  const busy = visible.some(exchange => exchange.busy)

  const send = (): void => {
    const objective = draft.trim()
    if (objective === '' || busy) return
    const id = ++seq.current
    setDraft('')
    setExchanges(previous => [...previous, { id, targetId, objective, busy: true }])
    void dispatchToTarget(target, objective)
      .then((reply) => {
        setExchanges(previous => previous.map(exchange => (
          exchange.id === id ? { ...exchange, busy: false, reply } : exchange
        )))
      })
      .catch((reason: unknown) => {
        const failure = reason instanceof Error ? reason.message : String(reason)
        setExchanges(previous => previous.map(exchange => (
          exchange.id === id ? { ...exchange, busy: false, failure } : exchange
        )))
      })
  }

  return (
    <section style={BAR} data-dispatch-dock={targetId}>
      <header style={HEAD}>
        <IconGlobeOutlineRegular size={14} />
        <span style={TITLE}>{t('dock.title', { node: target.nodeLabel })}</span>
        <code style={PATH}>{target.remotePath}</code>
        <button type="button" style={LINK} onClick={() => { clearDispatchTarget() }}>{t('dock.clear')}</button>
      </header>
      {visible.length > 0 && (
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
      <div style={INPUT_ROW}>
        <textarea
          value={draft}
          rows={2}
          placeholder={t('dock.placeholder', { node: target.nodeLabel })}
          style={INPUT}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <button
          type="button"
          style={busy || draft.trim() === '' ? SEND_DISABLED : SEND}
          disabled={busy || draft.trim() === ''}
          onClick={send}
        >
          {busy ? t('dock.sending') : t('dock.send')}
        </button>
      </div>
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
const INPUT_ROW: React.CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 8 }
const INPUT: React.CSSProperties = {
  flex: 1, minWidth: 0, resize: 'vertical', font: 'inherit', fontSize: 13, lineHeight: '20px',
  padding: '6px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l4)',
  background: 'transparent', color: 'inherit', outline: 'none',
}
const SEND: React.CSSProperties = {
  flex: 'none', height: 30, padding: '0 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--dsw-alias-interactive-bg-selected, rgba(255,255,255,0.12))', color: 'inherit', fontSize: 12,
}
const SEND_DISABLED: React.CSSProperties = { ...SEND, opacity: 0.5, cursor: 'default' }
