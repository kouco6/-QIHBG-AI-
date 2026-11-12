import { useEffect } from 'react'

/**
 * 全局快捷键（DESIGN §6.2.1 / §6.2.2）：
 * - `/` 聚焦全局搜索（由 AppShell 提供 onFocusSearch）
 * - `Ctrl/Cmd+S` 触发保存（表单页面）
 * - `Esc` 返回 / 关闭（弹窗或返回上一页）
 * 浏览器保留快捷键优先时不强行覆盖。
 */
export function useGlobalHotkeys(opts: {
  onFocusSearch?: () => void
  onSave?: () => void
  onEscape?: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (e.key === '/' && !typing) {
        e.preventDefault()
        opts.onFocusSearch?.()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        // 仅在提供保存回调且当前不在普通输入中时拦截，避免破坏输入框保存
        if (opts.onSave) {
          e.preventDefault()
          opts.onSave()
        }
        return
      }
      if (e.key === 'Escape') {
        opts.onEscape?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [opts.onFocusSearch, opts.onSave, opts.onEscape])
}
