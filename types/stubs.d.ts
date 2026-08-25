/**
 * Local type stubs for the client-injected UI packages.
 *
 * `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`
 * and `@deepseek-ai/dsh-client-ui-sidebar/client` are declared through the
 * plugin manifest's `dsh.client.inject` and are provided at runtime by the
 * DSH web ModuleLoader — they never exist as installable packages on a
 * contributor machine. tsconfig `paths` maps them here so `tsc` typechecks
 * against faithful minimal shapes; the emitted bundle keeps requiring the
 * real runtime modules (tsdown `neverBundle`).
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** A hook bound to one official client store snapshot (useSyncExternalStore shaped). */
  export interface SnapshotSelectorHook<S> {
    (selector: (state: S) => S): S
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {
  // Type-only module: importing it brings the official SlotMap declarations
  // (`sidebar.footer.action`) into this program.
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'

  export interface ButtonProps {
    className?: string
    variant?: 'outline' | 'ghost' | 'solid' | 'danger' | (string & {})
    size?: 'sm' | 'md' | 'lg' | (string & {})
    disabled?: boolean
    title?: string
    draggable?: boolean
    onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void
    onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerEnter?: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerLeave?: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onDragStart?: (event: ReactDragEvent<HTMLButtonElement>) => void
    onDragOver?: (event: ReactDragEvent<HTMLButtonElement>) => void
    onDrop?: (event: ReactDragEvent<HTMLButtonElement>) => void
    onDragEnd?: (event: ReactDragEvent<HTMLButtonElement>) => void
    children?: ReactNode
    /** The official primitive accepts a wider prop surface than this stub models. */
    [key: string]: unknown
  }
  export const Button: ComponentType<ButtonProps>

  /** Tiny colored status dot; `state`: ongoing | warning | done, `size`: px. */
  export const StateDot: ComponentType<{
    state: 'ongoing' | 'warning' | 'done' | (string & {})
    size?: number
    [key: string]: unknown
  }>

  export const IconTrashOutline16: ComponentType<{
    className?: string
    size?: number
    [key: string]: unknown
  }>
}
