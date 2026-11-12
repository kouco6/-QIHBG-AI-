import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/AuthProvider'
import { ApiError } from '@/services/api'

/**
 * 首账号初始化（/setup）
 * 仅数据库无账号时可用；创建者额外获得「系统设置」入口（业务权限与普通体验人员相同）。
 */
export default function SetupPage() {
  const { setup, bootstrap } = useAuth()
  const [form, setForm] = useState({ name: '', account: '', password: '', confirm: '' })
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [serverFields, setServerFields] = useState<Record<string, string>>({})

  const errors = {
    name: !form.name.trim() ? '请输入姓名' : '',
    account: !form.account.trim() ? '请输入账号' : form.account.trim().length < 3 ? '账号至少 3 个字符' : '',
    password: !form.password
      ? '请输入密码'
      : form.password.length < 8
        ? '密码至少 8 位'
        : form.password.startsWith(' ') || form.password.endsWith(' ')
          ? '密码首尾不能包含空格'
          : '',
    confirm: form.confirm !== form.password ? '两次输入不一致' : '',
  }
  const hasError = Object.values(errors).some(Boolean)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    setError(null)
    setServerFields({})
    if (hasError) return

    setSubmitting(true)
    try {
      await setup({
        name: form.name.trim(),
        account: form.account.trim(),
        password: form.password,
        confirm_password: form.confirm,
      })
    } catch (err) {
      const apiErr = err as ApiError
      setError({ message: apiErr.message ?? '创建失败，请稍后重试', requestId: apiErr.requestId })
      if (apiErr.fieldErrors?.length) {
        setServerFields(Object.fromEntries(apiErr.fieldErrors.map((f) => [f.field, f.message])))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const show = (k: 'name' | 'account' | 'password' | 'confirm') =>
    (submitted ? errors[k] : '') || serverFields[k === 'confirm' ? 'confirm_password' : k] || ''

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-card__title">创建首账号</h1>
        <p className="login-card__subtitle">仅首次启动、数据库尚无账号时可用</p>

        {bootstrap?.needs_setup === false ? (
          <div className="alert alert--warn" role="alert">
            首账号已存在，初始化入口已关闭。<Link to="/login">前往登录</Link>
          </div>
        ) : null}

        <div className="alert alert--muted">
          本系统采用<b>单一体验人员角色</b>：所有账号业务权限完全相同，仅用于操作溯源；首账号额外拥有「系统设置」入口。
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
          {(
            [
              ['name', '姓名', 'text'],
              ['account', '账号', 'text'],
              ['password', '密码', 'password'],
              ['confirm', '确认密码', 'password'],
            ] as const
          ).map(([key, label, type]) => (
            <div className="field" key={key}>
              <label className="field__label" htmlFor={key}>
                {label}
                <span className="req">*</span>
              </label>
              <input
                id={key}
                name={key}
                type={type}
                autoComplete={key === 'password' || key === 'confirm' ? 'new-password' : 'off'}
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                aria-invalid={Boolean(show(key))}
                disabled={submitting}
              />
              {show(key) ? <div className="field__error">{show(key)}</div> : null}
            </div>
          ))}

          <button type="submit" className="btn btn--primary" style={{ width: '100%' }} disabled={submitting}>
            {submitting ? '创建中…' : '创建并登录'}
          </button>
        </form>

        <div className="login-card__footer">
          已有账号？<Link to="/login">返回登录</Link>
        </div>
      </div>
    </div>
  )
}
