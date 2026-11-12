import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/app/AuthProvider'
import { ErrorState, ForbiddenState, LoadingState, ReadonlyState } from '@/components/StateBlocks'
import { ApiError } from '@/services/api'
import { accountsApi, settingsApi, type Account, type AuditRow, type SettingRow } from '@/services/auth'

/**
 * 系统设置（/settings）
 * 权限口径（T03）：所有登录账号可**读**；仅首账号可**写**，其他账号写入返回 403。
 * 同时展示账号目录与审计留痕，便于核对「谁改了什么」。
 */

const CATEGORY_LABEL: Record<string, string> = {
  auth: '鉴权',
  setting: '设置',
  business: '业务',
}

export default function SettingsPage() {
  const { account, isPrimary } = useAuth()
  const [settings, setSettings] = useState<SettingRow[] | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [audits, setAudits] = useState<AuditRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [notice, setNotice] = useState<string>('')
  const [denied, setDenied] = useState<string>('')
  /** 首屏加载即被拒（403）：整页呈现无权限态，而非笼统的“加载失败” */
  const [loadDenied, setLoadDenied] = useState<string>('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string>('')
  const [newAccount, setNewAccount] = useState({ name: '', account: '', password: '' })
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setLoadDenied('')
    try {
      const [s, a, log] = await Promise.all([
        settingsApi.list(),
        accountsApi.list(),
        settingsApi.auditLogs({ page_size: 12 }),
      ])
      setSettings(s)
      setAccounts(a)
      setAudits(log.items)
      setDraft(Object.fromEntries(s.map((row) => [row.key, row.value])))
    } catch (e) {
      const err = e as ApiError
      if (err.status === 403) setLoadDenied(err.message || '当前账号无权访问系统设置。')
      else setError({ message: err.message ?? '加载失败', requestId: err.requestId })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(key: string) {
    setSaving(key)
    setNotice('')
    setDenied('')
    try {
      await settingsApi.update(key, draft[key] ?? '')
      setNotice(`已保存 ${key}`)
      await load()
    } catch (e) {
      const err = e as ApiError
      if (err.status === 403) {
        setDenied(err.message)
      } else {
        setError({ message: err.message, requestId: err.requestId })
      }
    } finally {
      setSaving('')
    }
  }

  async function toggleAccount(target: Account) {
    setNotice('')
    setDenied('')
    try {
      await accountsApi.setStatus(target.id, !target.is_active)
      await load()
    } catch (e) {
      const err = e as ApiError
      if (err.status === 403) setDenied(err.message)
      else setError({ message: err.message, requestId: err.requestId })
    }
  }

  async function createAccount() {
    setNotice('')
    setDenied('')
    setCreating(true)
    try {
      await accountsApi.create(newAccount)
      setNotice(`已新增账号 ${newAccount.account}`)
      setNewAccount({ name: '', account: '', password: '' })
      await load()
    } catch (e) {
      const err = e as ApiError
      if (err.status === 403) setDenied(err.message)
      else setError({ message: err.message, requestId: err.requestId })
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <LoadingState rows={5} label="载入系统设置" />
  if (loadDenied) return <ForbiddenState reason={loadDenied} />
  if (error) return <ErrorState message={error.message} requestId={error.requestId} onRetry={load} />

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>系统设置</h1>
          <div className="text-secondary" style={{ fontSize: 13 }}>
            当前账号：{account?.name}（{account?.account}）· {isPrimary ? '首账号' : '体验人员'}
          </div>
        </div>
        <button type="button" className="btn" onClick={load}>
          刷新
        </button>
      </div>

      {!isPrimary ? <ReadonlyState reason="仅首账号可修改系统设置；你可以查看全部配置与留痕。" /> : null}
      {denied ? (
        <div className="alert alert--error" role="alert">
          {denied}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert--info" role="status">
          {notice}
        </div>
      ) : null}

      <div className="card">
        <h2 className="card__title">配置项</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 220 }}>配置键</th>
              <th style={{ width: 200 }}>值</th>
              <th>说明</th>
              <th style={{ width: 140 }}>最后修改</th>
              <th style={{ width: 96 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {(settings ?? []).map((row) => (
              <tr key={row.key}>
                <td className="mono">{row.key}</td>
                <td>
                  <input
                    aria-label={`${row.key} 的值`}
                    value={draft[row.key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                    disabled={!isPrimary}
                  />
                </td>
                <td className="text-secondary">{row.description}</td>
                <td className="text-tertiary" style={{ fontSize: 12 }}>
                  {row.updated_by ? `${row.updated_by}` : '默认'}
                  <div className="mono">{row.updated_at ?? ''}</div>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={!isPrimary || saving === row.key || draft[row.key] === row.value}
                    onClick={() => save(row.key)}
                  >
                    {saving === row.key ? '保存中…' : '保存'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="card__title">账号目录</h2>
        <div className="text-secondary" style={{ fontSize: 13, marginBottom: 8 }}>
          单一体验人员角色：所有账号业务权限一致，账号仅用于操作溯源。
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>账号</th>
              <th style={{ width: 110 }}>角色</th>
              <th style={{ width: 100 }}>状态</th>
              <th style={{ width: 180 }}>最近登录</th>
              <th style={{ width: 96 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {(accounts ?? []).map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="mono">{a.account}</td>
                <td>{a.is_primary ? <span className="badge badge--brand">首账号</span> : '体验人员'}</td>
                <td>{a.is_active ? '正常' : '已停用'}</td>
                <td className="text-tertiary" style={{ fontSize: 12 }}>
                  {a.last_login_at ?? '从未登录'}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={!isPrimary || a.id === account?.id}
                    onClick={() => toggleAccount(a)}
                  >
                    {a.is_active ? '停用' : '启用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isPrimary ? (
          <div className="row row--wrap" style={{ marginTop: 12 }}>
            <input
              className="input"
              aria-label="新账号姓名"
              placeholder="姓名"
              value={newAccount.name}
              onChange={(e) => setNewAccount((v) => ({ ...v, name: e.target.value }))}
            />
            <input
              className="input"
              aria-label="新账号登录名"
              placeholder="登录账号（≥3 字符）"
              value={newAccount.account}
              onChange={(e) => setNewAccount((v) => ({ ...v, account: e.target.value }))}
            />
            <input
              className="input"
              aria-label="新账号初始密码"
              type="password"
              placeholder="初始密码（≥8 位，含字母与数字）"
              value={newAccount.password}
              onChange={(e) => setNewAccount((v) => ({ ...v, password: e.target.value }))}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={creating || !newAccount.name || !newAccount.account || !newAccount.password}
              onClick={createAccount}
            >
              {creating ? '新增中…' : '新增账号'}
            </button>
          </div>
        ) : (
          <ForbiddenState reason="新增与启停账号仅首账号可执行。" />
        )}
      </div>

      <div className="card">
        <h2 className="card__title">审计留痕（最近 12 条）</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>分类</th>
              <th style={{ width: 160 }}>动作</th>
              <th style={{ width: 110 }}>操作者</th>
              <th>摘要</th>
              <th style={{ width: 170 }}>时间</th>
            </tr>
          </thead>
          <tbody>
            {(audits ?? []).map((row) => (
              <tr key={row.id}>
                <td>{CATEGORY_LABEL[row.category] ?? row.category}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {row.action}
                </td>
                <td>{row.actor_name || '—'}</td>
                <td className="text-secondary">{row.summary}</td>
                <td className="text-tertiary mono" style={{ fontSize: 12 }}>
                  {row.created_at ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(audits ?? []).length === 0 ? <div className="text-tertiary">暂无审计记录。</div> : null}
      </div>
    </div>
  )
}
