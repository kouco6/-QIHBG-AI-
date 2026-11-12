import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, type Column } from '@/components/DataTable'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { IssueStatusBadge } from '@/components/StatusBadge'
import { issuesApi, projectsApi, type IssueRow } from '@/services/endpoints'
import { BUSINESS_LEVEL_LABELS, SEVERITY_LABELS, DICT_TYPE_LABELS } from '@/constants'
import { useToast } from '@/components/Toast'

export default function IssuesPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [business, setBusiness] = useState('')
  const [severity, setSeverity] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState<null | 'level' | 'sync' | 'accept'>(null)
  const [newSeverity, setNewSeverity] = useState('major')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ project_id: '', description: '', module: '', business_level: 'core', severity: 'normal' })
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [acceptEvidence, setAcceptEvidence] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    projectsApi
      .list({ page_size: 200 })
      .then((p) => setProjects(p.items ?? []))
      .catch(() => setProjects([]))
  }, [])

  const state = useAsync(
    () =>
      issuesApi.list({
        q: q || undefined,
        business_level: business || undefined,
        severity: severity || undefined,
        status: status || undefined,
        page: String(page),
        page_size: String(pageSize),
      }),
    [q, business, severity, status, page, pageSize],
  )

  const columns: Column<IssueRow>[] = useMemo(
    () => [
      { key: 'id', header: 'ID', fixed: true, minWidth: 90, render: (r) => <a href={`/issues/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/issues/${r.id}`) }}>{r.uid ?? r.id.slice(0, 8)}</a> },
      { key: 'desc', header: '描述', minWidth: 220, className: 'wrap', render: (r) => r.description },
      { key: 'product', header: '项目 / 版本', minWidth: 140, render: (r) => `${r.project_name ?? '—'}${r.version_name ? ` / ${r.version_name}` : ''}` },
      { key: 'division', header: '事业部', minWidth: 110, render: (r) => r.division_name ?? '—' },
      { key: 'business', header: '业务等级', minWidth: 90, render: (r) => BUSINESS_LEVEL_LABELS[r.business_level ?? ''] ?? r.business_level ?? '—' },
      { key: 'severity', header: '问题等级', minWidth: 90, render: (r) => <span className={`tone-${r.severity === 'fatal' || r.severity === 'major' ? 'danger' : r.severity === 'normal' ? 'warning' : 'neutral'}`}>{SEVERITY_LABELS[r.severity ?? ''] ?? r.severity ?? '—'}</span> },
      { key: 'metric', header: '指标', minWidth: 110, render: (r) => r.metric_name ?? '—' },
      { key: 'status', header: '状态', minWidth: 90, render: (r) => <IssueStatusBadge status={r.status} /> },
      { key: 'owner', header: '责任人', minWidth: 100, render: (r) => r.owner_name ?? '—' },
      { key: 'source', header: '来源', minWidth: 90, render: (r) => r.source ?? '—' },
      { key: 'updated', header: '更新', minWidth: 130, align: 'right', className: 'num', render: (r) => (r.updated_at ?? '').slice(0, 16).replace('T', ' ') },
    ],
    [navigate],
  )

  async function runBatch(action: string, extra: Record<string, unknown> = {}) {
    if (selected.size === 0) return
    try {
      const res = await issuesApi.batch({ ids: Array.from(selected), action, preview: false, ...extra })
      toast.show(`批量${action}完成，影响 ${res.affected} 条`, 'success')
      setSelected(new Set())
      setBatchOpen(null)
      state.reload()
    } catch (e) {
      toast.show(`批量操作失败：${(e as Error).message}`, 'error')
    }
  }
  function previewBatch(action: string) {
    toast.show(`将预览 ${selected.size} 条记录的「${action}」影响范围（演示）`, 'info')
  }

  async function onCreate() {
    if (!form.project_id) { toast.show('请选择项目', 'warning'); return }
    if (!form.description.trim()) { toast.show('问题描述必填', 'warning'); return }
    if (!form.module.trim()) { toast.show('模块必填', 'warning'); return }
    setCreating(true)
    try {
      const created = await issuesApi.create({
        project_id: form.project_id,
        description: form.description.trim(),
        module: form.module.trim(),
        business_level: form.business_level,
        severity: form.severity,
      })
      toast.show('问题已登记', 'success')
      setCreateOpen(false)
      navigate(`/issues/${created.id}`)
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="问题中心"
        subtitle="查询与批量处理；默认按状态优先 + 更新时间倒序"
        actions={
          <>
            <button className="btn" onClick={() => previewBatch('改等级')} disabled={selected.size === 0}>批量改等级</button>
            <button className="btn" onClick={() => setBatchOpen('sync')} disabled={selected.size === 0}>批量同步</button>
            <button className="btn" onClick={() => setBatchOpen('accept')} disabled={selected.size === 0}>批量验收</button>
            <button className="btn btn--primary" onClick={() => setCreateOpen(true)}>新建问题</button>
          </>
        }
      />

      <div className="table-toolbar">
        <input className="input" placeholder="搜索描述 / ID" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} aria-label="搜索问题" />
        <select className="input" value={business} onChange={(e) => { setBusiness(e.target.value); setPage(1) }} aria-label="业务等级">
          <option value="">全部业务等级</option>
          {Object.entries(BUSINESS_LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1) }} aria-label="问题等级">
          <option value="">全部问题等级</option>
          {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="状态">
          <option value="">全部状态</option>
          {['draft', 'pending_confirm', 'pending_reply', 'in_progress', 'pending_acceptance', 'accepted', 'rejected', 'closed'].map((s) => (
            <option key={s} value={s}>{SEVERITY_LABELS[s] ? s : s}</option>
          ))}
        </select>
        <button className="btn" onClick={() => toast.show('已导出当前筛选结果', 'info')}>导出</button>
      </div>

      <AsyncBoundary
        state={state}
        emptyTitle="暂无问题"
        emptyReason="还没有登记任何体验问题。"
        emptyAction={<button className="btn btn--primary" onClick={() => navigate('/issues/new')}>新建问题</button>}
      >
        {(data) => (
          <DataTable
            columns={columns}
            rows={data.items}
            rowKey={(r) => r.id}
            selectable
            selectedIds={selected}
            onSelectedChange={setSelected}
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            onRowClick={(r) => navigate(`/issues/${r.id}`)}
            rangeHint={selected.size > 0 ? `已选 ${selected.size} 条（当前页 / 全部筛选结果）` : undefined}
            ariaLabel="问题列表"
          />
        )}
      </AsyncBoundary>

      <Modal open={batchOpen === 'level'} title="批量改问题等级" onClose={() => setBatchOpen(null)} footer={
        <>
          <button className="btn" onClick={() => setBatchOpen(null)}>取消</button>
          <button className="btn btn--primary" onClick={() => runBatch('改等级', { severity: newSeverity })}>确认修改</button>
        </>
      }>
        <label className="field__label" htmlFor="new-sev">目标问题等级</label>
        <select id="new-sev" className="input" style={{ width: '100%' }} value={newSeverity} onChange={(e) => setNewSeverity(e.target.value)}>
          {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Modal>

      <Modal open={batchOpen === 'sync'} title="批量同步（Mock）" onClose={() => setBatchOpen(null)} footer={
        <>
          <button className="btn" onClick={() => setBatchOpen(null)}>取消</button>
          <button className="btn btn--primary" onClick={() => runBatch('同步')}>确认同步</button>
        </>
      }>
        将把 {selected.size} 条问题同步至 Mock 飞书回执（不发起外部调用）。
      </Modal>

      <Modal open={batchOpen === 'accept'} title="批量验收" onClose={() => setBatchOpen(null)} footer={
        <>
          <button className="btn" onClick={() => setBatchOpen(null)}>取消</button>
          <button className="btn btn--primary" onClick={() => runBatch('验收', { evidence: acceptEvidence.trim() })}>确认验收</button>
        </>
      }>
        <p>将把 {selected.size} 条待验收问题标记为已通过验收。</p>
        <div className="field">
          <label className="field__label" htmlFor="accept-evidence">验收证据<span className="req">*</span></label>
          <textarea id="accept-evidence" className="input" style={{ width: '100%', minHeight: 60 }} placeholder="如复测记录、截图编号或评审结论" value={acceptEvidence} onChange={(e) => setAcceptEvidence(e.target.value)} />
        </div>
      </Modal>

      <div className="text-tertiary" style={{ marginTop: 8, fontSize: 12 }}>字典入口：{Object.entries(DICT_TYPE_LABELS).map(([, v]) => v).join(' / ')}</div>

      <Modal open={createOpen} title="新建问题" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={onCreate} disabled={creating}>{creating ? '创建中…' : '创建'}</button>
        </>
      }>
        <div className="field">
          <label className="field__label" htmlFor="iss-desc">问题描述<span className="req">*</span></label>
          <textarea id="iss-desc" className="input" style={{ width: '100%', minHeight: 70 }} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="iss-proj">项目<span className="req">*</span></label>
            <select id="iss-proj" className="input" style={{ width: '100%' }} value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
              <option value="">请选择项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="iss-module">模块<span className="req">*</span></label>
            <input id="iss-module" className="input" style={{ width: '100%' }} placeholder="如 投屏、麦克风" value={form.module} onChange={(e) => setForm((f) => ({ ...f, module: e.target.value }))} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="iss-biz">业务等级</label>
            <select id="iss-biz" className="input" style={{ width: '100%' }} value={form.business_level} onChange={(e) => setForm((f) => ({ ...f, business_level: e.target.value }))}>
              {Object.entries(BUSINESS_LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="iss-sev">问题等级</label>
            <select id="iss-sev" className="input" style={{ width: '100%' }} value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
              {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  )
}
