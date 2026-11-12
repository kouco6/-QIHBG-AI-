import { useCallback, useEffect, useRef, useState } from 'react'
import { errMessage, type ErrorMessage } from '@/services/endpoints'

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: ErrorMessage | null
  reload: () => void
}

/**
 * 通用异步数据加载：统一产生「加载 / 错误 / 数据」三态，配合 StateBlocks 即可覆盖五态。
 * `isEmpty` 用于在无数据时显示空态而非错误。
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  _isEmpty?: (data: T) => boolean,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ErrorMessage | null>(null)
  const mounted = useRef(true)

  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    loader()
      .then((d) => {
        if (!mounted.current) return
        setData(d)
      })
      .catch((e) => {
        if (!mounted.current) return
        setError(errMessage(e))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    mounted.current = true
    reload()
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error, reload }
}

export function isEmptyList<T>(data: { items?: T[] } | null): boolean {
  return !data || !data.items || data.items.length === 0
}
