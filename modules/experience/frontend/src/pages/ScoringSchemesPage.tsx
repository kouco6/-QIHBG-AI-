import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { scoringApi, type SchemeRow } from '@/services/endpoints'
import { BUSINESS_RATIOS, PROBLEM_RATIOS } from '@/constants'
import { useAuth } from '@/app/AuthProvider'
import { useToast } from '@/components/Toast'

export default function ScoringSchemesPage() {
  const { isPrimary } = useAuth()
  const toast = useToast()
  const state = useAsync(() => scoringApi.listSchemes(), [])
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ business_ratio: '8:2', problem_ratio: '7:5:3:1', name: '' })
  const [creating, setCreating] = useState(false)

  async function onCreate() {
    if (!form.name.trim()) { toast.show('方案名称必填', 'warning'); return }
    setCreating(true)
    try {
      await scoringApi.createScheme({ business_ratio: form.business_ratio, problem_ratio: form.problem_ratio, name: form.name.trim() })
      toast.show('已新建方案版本', 'success')
      setCreateOpen(false)
      setForm({ business_ratio: '8:2', problem_ratio: '7:5:3:1', name: '' })
      state.reload()
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }
  async function setDefault(s: SchemeRow) {
    if (!isPrimary) { toast.show('仅首账号可设置默认方案', 'warning'); return }
    try {
      await scoringApi.setDefault(s.id)
      toast.show('已设为默认方案', 'success')
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }
  async function disable(s: SchemeRow) {
    if (!isPrimary) { toast.show('仅首账号可停用方案', 'warning'); return }
    try {
      await scoringApi.disable(s.id)
      toast.show('已停用方案', 'success')
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader
        title="评分方案管理"
        subtitle={isPrimary ? '查看 / 新建方案版本（首账号可写）' : '只读：仅首账号可新建与停用方案'}
        actions={isPrimary ? <button className="btn btn--primary" onClick={() => setCreateOpen(true)}>新建方案版本</button> : undefined}
      />

      <AsyncBoundary
        state={state}
        isEmpty={(data) => !data.items || data.items.length === 0}
        emptyTitle="暂无评分方案"
        emptyReason="系统尚未配置评分方案。"
      >
        {(data) => (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 160 }}>方案</th>
                  <th style={{ width: 110 }}>业务比</th>
                  <th style={{ width: 110 }}>问题比</th>
                  <th style={{ width: 90 }}>引用数</th>
                  <th style={{ width: 90 }}>状态</th>
                  <th style={{ width: 180 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data.items as SchemeRow[]).map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}{s.is_default ? '（默认）' : ''}<div className="text-tertiary" style={{ fontSize: 12 }}>{s.code}</div></td>
                    <td>{s.business_ratio}</td>
                    <td>{s.problem_ratio}</td>
                    <td className="num">{s.ref_count ?? 0}</td>
                    <td>{s.status ?? '启用'}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn" disabled={!isPrimary || s.is_default} onClick={() => setDefault(s)}>设默认</button>
                        <button className="btn" disabled={!isPrimary} onClick={() => disable(s)}>停用</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBoundary>

      <Modal open={createOpen} title="新建评分方案版本" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={onCreate} disabled={creating}>{creating ? '创建中…' : '创建并校验'}</button>
        </>
      }>
        <div className="field">
          <label className="field__label" htmlFor="sc-name">方案名称<span className="req">*</span></label>
          <input id="sc-name" className="input" style={{ width: '100%' }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="sc-biz">业务比</label>
            <select id="sc-biz" className="input" style={{ width: '100%' }} value={form.business_ratio} onChange={(e) => setForm((f) => ({ ...f, business_ratio: e.target.value }))}>
              {BUSINESS_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="sc-prob">问题比</label>
            <select id="sc-prob" className="input" style={{ width: '100%' }} value={form.problem_ratio} onChange={(e) => setForm((f) => ({ ...f, problem_ratio: e.target.value }))}>
              {PROBLEM_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div className="field-hint">新建默认进行 20 套方案完整性校验（业务比 × 问题比 = 20 组合）。</div>
        <div className="field-hint">当前 4 种业务比 × 5 种问题比已被 20 套内置方案全部覆盖；重复组合会被拒绝并提示「方案编码已存在 / 组合已存在」。</div>
      </Modal>
    </div>
  )
}
