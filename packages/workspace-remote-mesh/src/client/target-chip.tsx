/**
 * The dispatch target, shown where the composer can see it.
 *
 * The hero chip belongs to the conversation shell and always names the local
 * Workspace; a picker row that lives on another machine cannot change it. This
 * chip is the visible half of that state: which machine the next dispatched task
 * goes to, and one click to forget it.
 */
import { IconGlobeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { clearDispatchTarget, useDispatchTarget } from './dispatch-target'
import type { RemoteTranslate } from './locales'

/**
 * Render the chip while a remote target is set.
 * @param props.t - this package's translate seat.
 * @returns the chip, or null when this machine is the target.
 */
export function DispatchTargetChip({ t }: { t: RemoteTranslate }): JSX.Element | null {
  const target = useDispatchTarget()
  if (target === undefined) return null
  return (
    <Tooltip label={t('target.clear', { node: target.nodeLabel })} side="top" delayMs={400}>
      <button
        type="button"
        style={CHIP}
        aria-label={t('target.aria', { node: target.nodeLabel, name: target.title })}
        onClick={() => { clearDispatchTarget() }}
        data-dispatch-target={target.nodeId}
      >
        <IconGlobeOutlineRegular size={14} />
        <span style={LABEL}>{target.nodeLabel} · {target.title}</span>
      </button>
    </Tooltip>
  )
}

const CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 220, height: 24, padding: '0 8px',
  border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}
const LABEL: React.CSSProperties = { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontSize: 12 }
