/**
 * 会话上下文（T03）。
 *
 * 单一体验人员角色：所有账号业务权限一致；`account.is_primary` 决定是否显示「系统设置」写入口。
 * 未登录统一 401 → 前端清除会话状态并跳登录页。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { authApi, type Account, type BootstrapStatus } from '@/services/auth'
import { ApiError } from '@/services/api'

interface AuthContextValue {
  account: Account | null
  bootstrap: BootstrapStatus | null
  loading: boolean
  isPrimary: boolean
  login: (account: string, password: string, remember: boolean) => Promise<void>
  setup: (payload: { name: string; account: string; password: string; confirm_password: string }) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const status = await authApi.bootstrap()
      setBootstrap(status)
      if (status.needs_setup) {
        setAccount(null)
        return
      }
      try {
        setAccount(await authApi.me())
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setAccount(null)
        } else {
          throw e
        }
      }
    } catch {
      // 后端不可用时保持未登录态，由页面自行提示
      setAccount(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (name: string, password: string, remember: boolean) => {
    const result = await authApi.login({ account: name, password, remember })
    setAccount(result.account)
    setBootstrap((prev) => (prev ? { ...prev, needs_setup: false, account_count: prev.account_count || 1 } : prev))
  }, [])

  const setup = useCallback(
    async (payload: { name: string; account: string; password: string; confirm_password: string }) => {
      const result = await authApi.setup(payload)
      setAccount(result.account)
      setBootstrap({ needs_setup: false, account_count: 1, role_model: 'single-experience-member' })
    },
    [],
  )

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      setAccount(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      bootstrap,
      loading,
      isPrimary: Boolean(account?.is_primary),
      login,
      setup,
      logout,
      refresh,
    }),
    [account, bootstrap, loading, login, setup, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用')
  }
  return ctx
}
