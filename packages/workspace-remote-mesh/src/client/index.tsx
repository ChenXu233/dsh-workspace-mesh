/**
 * Experiment: shadow the workspace seat and draw the host's own browser through
 * proton's entry face, so the props the host renderer would synthesize are
 * supplied by this package instead.
 */
import { Component } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { ShippedWorkspaceList } from './shipped'

/** Surfaces a render failure in the DOM, so a blank region never hides its cause. */
class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  override state = { message: null as string | null }
  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }
  override render(): ReactNode {
    if (this.state.message !== null) {
      return <div data-seat-error={this.state.message} style={{ padding: '8px 12px', fontSize: 12, lineHeight: '16px', color: '#d97706' }}>{this.state.message}</div>
    }
    return this.props.children
  }
}

export const inject = ['slots'] as const

const SEAT = 'sidebar.workspaces'

/** Our own wrapper identity: the lookup for the shipped entry must skip it. */
function Wrapper({ ctx, onError }: { ctx: Context, onError: (message: string) => JSX.Element }): JSX.Element {
  // The marker is the experiment's evidence: it proves this region is drawn by
  // our face rather than by the shipped plugin reacting as if we were absent.
  return (
    <Boundary>
      <div data-face="proton-entry-face"><ShippedWorkspaceList ctx={ctx} self={Wrapper} onError={onError} /></div>
    </Boundary>
  )
}

/** The slice of the slots service this takeover needs. */
interface RawSlots {
  inject(key: string, callback: () => () => void): () => void
  register(options: { name: string }, component: unknown): () => void
  entriesOfSlot(key: string): readonly { component: unknown }[]
  subscribe(key: string, listener: () => void): () => void
}

/**
 * Take the seat and render the shipped occupant, or say why it cannot be drawn.
 *
 * A single slot has no arbitration: the last registrant wins. The shipped plugin
 * registers from its own apply, which can land after ours, so taking the seat is
 * not a one-off call — it has to hold it.
 * @param ctx - client root context.
 */
/**
 * Off: competing for a single seat by re-registering from a subscriber fights
 * the slot's own change stream and livelocks the shell. A takeover has to go
 * through proton's outlet, which exists precisely to hold a seat.
 */
const ENABLED = false

export function apply(ctx: Context): void {
  if (!ENABLED) return
  const slots = ctx.slots as unknown as RawSlots
  const Component = (owner: { onError?: never }) => (
    <Wrapper
      ctx={ctx}
      onError={(message) => (
        <div data-seat-error={message} style={{ padding: '8px 12px', fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-state-warning-primary, #d97706)' }}>
          {message}
        </div>
      )}
    />
  )

  ctx.effect(() => slots.inject(SEAT, () => {
    let dispose: (() => void) | undefined
    // Disposing and re-registering both notify this same subscriber; without the
    // guard the re-entry recurses until the boot dies.
    let busy = false
    const hold = (): void => {
      if (busy) return
      busy = true
      try {
        const winner = slots.entriesOfSlot(SEAT)[0]
        if (winner?.component === Component) return
        dispose?.()
        dispose = slots.register({ name: SEAT }, Component)
      } finally {
        busy = false
      }
    }
    hold()
    const stop = slots.subscribe(SEAT, hold)
    return () => {
      stop()
      dispose?.()
    }
  }), 'remote-mesh: shipped workspace list')
}
