import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/AuthProvider'
import { ApiError } from '@/services/api'

const REMEMBER_KEY = 'uei.rememberedAccount'

/**
 * 登录页（/login）
 * 失败时后端不区分「账号不存在」与「密码错误」，前端同样只展示统一提示（DESIGN §6.2.3）。
 */
export default function LoginPage() {
  const { login } = useAuth()
  const [account, setAccount] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(() => Boolean(localStorage.getItem(REMEMBER_KEY)))
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)

  const accountError = touched && !account.trim() ? '请输入账号' : ''
  const passwordError = touched && !password ? '请输入密码' : ''

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    setError(null)
    if (!account.trim() || !password) return

    setSubmitting(true)
    try {
      await login(account.trim(), password, remember)
      if (remember) {
        localStorage.setItem(REMEMBER_KEY, account.trim())
      } else {
        localStorage.removeItem(REMEMBER_KEY)
      }
    } catch (err) {
      const apiErr = err as ApiError
      setError({ message: apiErr.message ?? '登录失败，请稍后重试', requestId: apiErr.requestId })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__logo">
          <img src="/platform/logo.png" alt="" style={{ width: 72, height: 48, objectFit: 'contain' }} />
          <span style={{ fontSize: 13, color: '#4A5F80' }}>产品企划部 · 体验组</span>
        </div>
        <h1 className="login-card__title">登录产品体验中心</h1>
        <p className="login-card__subtitle">UEI Experience Workbench · 本地部署，无需外部账号</p>

        <div className="alert alert--info">
          本地模式：未配置外部凭证时，飞书 / AI 能力自动使用 <b>Mock</b>，接口回执带 <code>mock_</code> 前缀。
        </div>

        {error ? (
          <div className="alert alert--error" role="alert">
            <div>{error.message}</div>
            {error.requestId ? (
              <div className="text-tertiary mono" style={{ fontSize: 12, marginTop: 4 }}>
                请求编号：{error.requestId}
              </div>
            ) : null}
          </div>
        ) : null}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="account">
              账号<span className="req">*</span>
            </label>
            <input
              id="account"
              name="account"
              autoComplete="username"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(accountError)}
              aria-describedby={accountError ? 'account-error' : undefined}
              disabled={submitting}
            />
            {accountError ? (
              <div className="field__error" id="account-error">
                {accountError}
              </div>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              密码<span className="req">*</span>
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(passwordError)}
              aria-describedby={passwordError ? 'password-error' : undefined}
              disabled={submitting}
            />
            {passwordError ? (
              <div className="field__error" id="password-error">
                {passwordError}
              </div>
            ) : null}
          </div>

          <label className="row" style={{ gap: 8, fontSize: 13, marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={submitting}
            />
            记住账号
          </label>

          <button type="submit" className="btn btn--primary" style={{ width: '100%' }} disabled={submitting}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="login-card__footer">
          首次使用？<Link to="/setup">创建首账号</Link>（仅数据库无账号时可用）
        </div>
      </div>
    </div>
  )
}
