import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState, EmptyState, ForbiddenState, ReadonlyState, LoadingState } from './StateBlocks'
import { type AsyncState } from '@/hooks/useAsync'

/**
 * 五态边界：统一处理 加载 / 错误（含 401 登录失效、403 无权限）/ 空 / 无数据 / 数据。
 * 用于所有业务页面的外层包装。
 *
 * 401/403 依赖 useAsync 透传的 HTTP 状态码，不能只看 message 文案。
 */
export function AsyncBoundary<T>({
  state,
  isEmpty,
  emptyTitle,
  emptyReason,
  emptyAction,
  children,
}: {
  state: AsyncState<T>
  isEmpty?: (data: T) => boolean
  emptyTitle?: string
  emptyReason?: string
  emptyAction?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (state.loading) return <LoadingState rows={6} />
  if (state.error) {
    if (state.error.status === 401) {
      return (
        <ErrorState title="登录已失效" message="会话已过期或未登录，请重新登录后继续。" requestId={state.error.requestId}>
          <span style={{ display: 'inline-block', marginTop: 12 }}>
            <Link className="btn btn--primary" to="/login">重新登录</Link>
          </span>
        </ErrorState>
      )
    }
    if (state.error.status === 403) {
      return (
        <ForbiddenState reason="当前操作需要首账号权限，或登录已失效。你可以用体验人员身份返回业务页面继续工作。" />
      )
    }
    return <ErrorState message={state.error.message} requestId={state.error.requestId} onRetry={state.reload} />
  }
  if (state.data === null) {
    return <EmptyState title={emptyTitle ?? '暂无数据'} reason={emptyReason} action={emptyAction} />
  }
  if (isEmpty && isEmpty(state.data)) {
    return <EmptyState title={emptyTitle ?? '暂无数据'} reason={emptyReason} action={emptyAction} />
  }
  return <>{children(state.data)}</>
}

export function ReadonlyNote({ reason }: { reason: string }) {
  return <ReadonlyState reason={reason} />
}
