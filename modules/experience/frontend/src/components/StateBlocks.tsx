import type { ReactNode } from 'react'

/** 页面五态：加载 / 空 / 错误 / 无权限 / 只读（DESIGN §6.2.3） */

export function LoadingState({ rows = 3, label = '载入中' }: { rows?: number; label?: string }) {
  return (
    <div className="card" role="status" aria-live="polite" aria-busy="true">
      <div className="visually-hidden">{label}</div>
      <div className="stack">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" style={{ width: `${92 - i * 12}%` }} />
        ))}
      </div>
    </div>
  )
}

export function EmptyState({ title, reason, action }: { title: string; reason?: string; action?: ReactNode }) {
  return (
    <div className="state-block" role="status">
      <div className="state-block__title">{title}</div>
      {reason ? <div>{reason}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  )
}

export function ErrorState({ title = '加载失败', message, requestId, onRetry, children }: { title?: string; message: string; requestId?: string; onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className="state-block" role="alert">
      <div className="state-block__title">{title}</div>
      <div>{message}</div>
      {requestId ? (
        <div className="text-tertiary mono" style={{ fontSize: 12, marginTop: 6 }}>
          请求编号：{requestId}
        </div>
      ) : null}
      {children}
      {onRetry ? (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ForbiddenState({ reason = '该操作仅首账号可执行。' }: { reason?: string }) {
  return (
    <div className="state-block" role="alert">
      <div className="state-block__title">无操作权限</div>
      <div>{reason}</div>
    </div>
  )
}

export function ReadonlyState({ reason }: { reason: string }) {
  return (
    <div className="alert alert--muted" role="note">
      只读：{reason}
    </div>
  )
}
