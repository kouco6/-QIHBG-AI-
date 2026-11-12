import { useEffect, useId, useRef, type ReactNode } from 'react'

/** 模态弹窗：打开时锁定焦点并管理 Esc 关闭，关闭后归还焦点（DESIGN §6.2.3 无障碍） */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    lastFocused.current = document.activeElement as HTMLElement | null
    const node = ref.current
    const firstFocusable = () =>
      node?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
    firstFocusable()?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        // 每次 Tab 重新收集，兼容弹窗内动态增删的控件
        const focusables = Array.from(
          node?.querySelectorAll<HTMLElement>(
            'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    node?.addEventListener('keydown', onKey)
    return () => {
      node?.removeEventListener('keydown', onKey)
      if (lastFocused.current?.isConnected) lastFocused.current.focus()
    }
    // 仅在 open 变化时重建焦点管理；onClose 经 ref 取用，避免父组件重渲染导致焦点被重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} style={width ? { maxWidth: width } : undefined}>
        <h2 className="modal__title" id={titleId}>{title}</h2>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  )
}

/** 确认弹窗（高影响/不可逆操作，DESIGN §6.2.3） */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>{cancelText}</button>
          <button
            type="button"
            className={danger ? 'btn btn--primary' : 'btn btn--primary'}
            style={danger ? { background: 'var(--color-status-danger, #d9382e)', borderColor: 'var(--color-status-danger, #d9382e)' } : undefined}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div>{message}</div>
    </Modal>
  )
}
