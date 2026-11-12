import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { systemsApi, scoringApi, projectsApi, type SystemDetail, type SystemMember } from '@/services/endpoints'
import { formatDateTime, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

/** analytics 返回的 L2PreviewOut（services 层未适配，按呈现需要局部读取）。 */
interface L2Preview {
  scheme?: { code?: string; name?: string }
  selection_mode_label?: string
  authoritative_uei?: string
  display_uei?: string
  auxiliary?: { weighted_average_uei?: string; bucket_uei?: string; caliber_weighted?: string; caliber_bucket?: string }
  cell_counts?: Record<string, number>
  sample_sufficient?: boolean
  sample_gap?: string
}

export default function SystemDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => systemsApi.get(id), [id])
  const analyticsState = useAsync(() => systemsApi.analytics(id), [id])
  const schemeState = useAsync(() => scoringApi.listSchemes(), [])
  const systemsState = useAsync(() => systemsApi.list({ page_size: '200' }), [])

  const [schemeOpen, setSchemeOpen] = useState(false)
  const [schemeId, setSchemeId] = useState('')
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTarget, setTransferTarget] = useState('')
  const [transferWeight, setTransferWeight] = useState('1')
  const [transferPid, setTransferPid] = useState('')
  const [weights, setWeights] = useState<Record<string, string>>({})

  // 添加项目到本系统
  const [addOpen, setAddOpen] = useState(false)
  const [addPid, setAddPid] = useState('')
  const [addWeight, setAddWeight] = useState('1')
  const projectsState = useAsync(() => projectsApi.list({ page_size: '200' }), [])
  const existingPids = new Set((state.data?.members ?? []).map((m) => m.project_id))
  const availableProjects = (projectsState.data?.items ?? []).filter((p) => !existingPids.has(p.id))

  const schemeOptions = (schemeState.data?.items ?? []).filter((s) => s.is_active !== false)
  const preview = (analyticsState.data ?? {}) as unknown as L2Preview

  const otherSystems = (systemsState.data?.items ?? []).filter((s) => s.id !== id)

  // 同步后端成员权重到本地可编辑副本
  useEffect(() => {
    if (state.data) {
      const m: Record<string, string> = {}
      for (const x of state.data.members ?? []) m[x.project_id] = x.weight ?? '1'
      setWeights(m)
    }
  }, [state.data])

  async function changeScheme() {
    if (!schemeId) { toast.show('请选择目标方案', 'warning'); return }
    try {
      await systemsApi.changeScheme(id, { scheme_id: schemeId })
      toast.show('已切换方案（历史快照不受影响）', 'success')
      setSchemeOpen(false)
      state.reload()
      analyticsState.reload()
    } catch (e) {
      toast.show(`切换失败：${(e as Error).message}`, 'error')
    }
  }

  async function generateSnapshot() {
    try {
      const snap = await systemsApi.createSnapshot({ system_id: id, selection_mode: 'latest' })
      toast.show('已生成系统合并 UEI 快照', 'success')
      navigate(`/scores/system-snapshots/${snap.id}`)
    } catch (e) {
      toast.show(`生成失败：${(e as Error).message}`, 'error')
    }
  }

  async function commitWeight(m: SystemMember) {
    const next = weights[m.project_id]
    if (next === undefined || next === (m.weight ?? '1')) return
    try {
      await systemsApi.setMemberWeight(id, m.project_id, { weight: next })
      toast.show(`已更新「${m.project_name}」权重`, 'success')
      state.reload()
      analyticsState.reload()
    } catch (e) {
      toast.show(`权重更新失败：${(e as Error).message}`, 'error')
      setWeights((w) => ({ ...w, [m.project_id]: m.weight ?? '1' }))
    }
  }

  function openTransfer(m: SystemMember) {
    setTransferPid(m.project_id)
    setTransferWeight(weights[m.project_id] ?? m.weight ?? '1')
    setTransferTarget('')
    setTransferOpen(true)
  }
  async function doTransfer() {
    if (!transferTarget) { toast.show('请选择目标系统', 'warning'); return }
    try {
      await systemsApi.attachProject(transferTarget, { project_id: transferPid, weight: transferWeight })
      toast.show('已转移 / 移出至目标系统', 'success')
      setTransferOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`转移失败：${(e as Error).message}`, 'error')
    }
  }

  function openAdd() {
    setAddPid('')
    setAddWeight('1')
    setAddOpen(true)
  }
  async function doAdd() {
    if (!addPid) { toast.show('请选择要添加的项目', 'warning'); return }
    try {
      await systemsApi.attachProject(id, { project_id: addPid, weight: addWeight })
      toast.show('已添加项目到系统', 'success')
      setAddOpen(false)
      state.reload()
      analyticsState.reload()
    } catch (e) {
      toast.show(`添加失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="系统不存在" emptyReason="未找到该系统。">
        {(d: SystemDetail) => (
          <>
            <PageHeader
              title={d.name}
              subtitle={`${d.code} · 方案 ${d.scheme_code ?? '—'} · 负责人 ${d.owner_text ?? '—'}`}
              actions={
                <>
                  <button className="btn" onClick={() => navigate(`/systems/${id}/analytics`)}>统计</button>
                  <button className="btn" onClick={() => { setSchemeId(d.scheme_id ?? ''); setSchemeOpen(true) }}>切换方案</button>
                  <button className="btn" onClick={openAdd}>添加项目</button>
                  <button className="btn btn--primary" onClick={generateSnapshot}>生成系统合并 UEI 快照</button>
                </>
              }
            />

            <div className="grid-2">
              <section className="card">
                <h2 className="card__title">基础信息</h2>
                <dl className="detail-grid">
                  <dt>编码</dt><dd>{d.code}</dd>
                  <dt>负责人</dt><dd>{d.owner_text ?? '—'}</dd>
                  <dt>方案版本</dt><dd>{d.scheme_code ?? '—'}</dd>
                  <dt>状态</dt><dd>{d.status === 'archived' ? '已停用' : '启用'}</dd>
                  <dt>成员数</dt><dd className="num">{d.member_count ?? (d.members?.length ?? 0)}</dd>
                  <dt>有效项目数</dt><dd className="num">{d.effective_project_count ?? 0}</dd>
                  <dt>更新</dt><dd className="num">{formatDateTime(d.updated_at)}</dd>
                </dl>
              </section>

              <section className="card">
                <h2 className="card__title">合并 UEI 预览</h2>
                <AsyncBoundary state={analyticsState} emptyTitle="暂无合并预览" emptyReason="该系统尚无评价数据，无法预览合并 UEI。">
                  {() => (
                    <dl className="detail-grid">
                      <dt>权威 UEI（去重重算）</dt><dd className="num glow-number">{fmt1(preview.authoritative_uei)}</dd>
                      <dt>加权 UEI（默认展示）</dt><dd className="num">{fmt1(preview.auxiliary?.weighted_average_uei)}</dd>
                      <dt>木桶分</dt><dd className="num">{fmt1(preview.auxiliary?.bucket_uei)}</dd>
                      <dt>样本状态</dt><dd>{preview.sample_sufficient === false ? '样本不足，不排名' : '样本充足'}</dd>
                      <dt>单元计数</dt><dd className="num">{preview.cell_counts ? Object.values(preview.cell_counts).reduce((a, b) => a + b, 0) : 0}</dd>
                    </dl>
                  )}
                </AsyncBoundary>
                <div className="field-hint">权威口径为对外与排名依据；加权 / 木桶仅供对比参考。</div>
              </section>

              <section className="card" style={{ gridColumn: '1 / -1' }}>
                <h2 className="card__title">成员项目（含历史，可内联改权重）</h2>
                <table className="data-table" aria-label="成员项目">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>版本</th>
                      <th>类型</th>
                      <th>负责人</th>
                      <th>权重</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.members ?? []).map((m) => (
                      <tr key={m.id}>
                        <td>{m.project_name}</td>
                        <td>{m.version_code ?? '—'}</td>
                        <td>{m.project_type ?? '—'}</td>
                        <td>{m.owner_text ?? '—'}</td>
                        <td>
                          <input
                            className="input"
                            style={{ width: 80 }}
                            value={weights[m.project_id] ?? m.weight ?? '1'}
                            onChange={(e) => setWeights((w) => ({ ...w, [m.project_id]: e.target.value }))}
                            onBlur={() => commitWeight(m)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            aria-label={`${m.project_name} 权重`}
                          />
                        </td>
                        <td>{m.status === 'archived' ? '已停用' : '进行中'}</td>
                        <td>
                          <button className="btn" style={{ height: 26, fontSize: 12 }} onClick={() => openTransfer(m)}>转移 / 移出</button>
                        </td>
                      </tr>
                    ))}
                    {(d.members ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 20 }}>
                          <div className="text-tertiary" style={{ marginBottom: 10 }}>本系统暂无成员项目</div>
                          <button className="btn btn--primary" onClick={openAdd}>添加项目到本系统</button>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>

              <section className="card" style={{ gridColumn: '1 / -1' }}>
                <h2 className="card__title">快照历史</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.snapshot_history ?? []).map((s) => (
                    <li key={s.id}><a href={`/scores/system-snapshots/${s.id}`} onClick={(e) => { e.preventDefault(); navigate(`/scores/system-snapshots/${s.id}`) }}>快照 {s.id}</a> · {formatDateTime(s.snapshot_at)}{s.authoritative_uei !== undefined ? ` · UEI ${s.authoritative_uei}` : ''}</li>
                  ))}
                  {d.snapshot_history && d.snapshot_history.length === 0 ? <li className="text-tertiary">暂无快照</li> : null}
                </ul>
              </section>
            </div>

            <Modal open={schemeOpen} title="切换绑定方案" onClose={() => setSchemeOpen(false)} footer={
              <>
                <button className="btn" onClick={() => setSchemeOpen(false)}>取消</button>
                <button className="btn btn--primary" onClick={changeScheme}>切换（自增 scheme_version）</button>
              </>
            }>
              <label className="field__label" htmlFor="scheme-id">目标方案</label>
              <select id="scheme-id" className="input" style={{ width: '100%' }} value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
                <option value="">请选择方案</option>
                {schemeOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.is_default ? '（默认）' : ''}</option>
                ))}
              </select>
              <div className="field-hint">至少一个方案；历史快照不受影响。</div>
            </Modal>

            <Modal open={transferOpen} title="转移 / 移出项目" onClose={() => setTransferOpen(false)} footer={
              <>
                <button className="btn" onClick={() => setTransferOpen(false)}>取消</button>
                <button className="btn btn--primary" onClick={doTransfer}>确认转移</button>
              </>
            }>
              <label className="field__label" htmlFor="transfer-target">目标系统</label>
              <select id="transfer-target" className="input" style={{ width: '100%' }} value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
                <option value="">请选择目标系统</option>
                {otherSystems
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
              <div className="field" style={{ marginTop: 12 }}>
                <label className="field__label" htmlFor="transfer-weight">权重</label>
                <input id="transfer-weight" className="input" style={{ width: '100%' }} value={transferWeight} onChange={(e) => setTransferWeight(e.target.value)} />
              </div>
              <div className="field-hint">项目直挂系统且唯一；选其它系统即完成转移（移出当前系统）。</div>
            </Modal>

            <Modal open={addOpen} title="添加项目到本系统" onClose={() => setAddOpen(false)} footer={
              <>
                <button className="btn" onClick={() => setAddOpen(false)}>取消</button>
                <button className="btn btn--primary" onClick={doAdd}>添加</button>
              </>
            }>
              <div className="field">
                <label className="field__label" htmlFor="add-pid">选择项目<span className="req">*</span></label>
                <select id="add-pid" className="input" style={{ width: '100%' }} value={addPid} onChange={(e) => setAddPid(e.target.value)}>
                  <option value="">请选择项目（可归入未在本系统的项目）</option>
                  {availableProjects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.system?.name ? `（现属：${p.system.name}）` : '（未归属）'}</option>
                  ))}
                </select>
                <div className="field-hint">项目直挂系统且唯一；选择其它系统的项目即完成转移归入本系统。</div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="add-weight">权重</label>
                <input id="add-weight" className="input" style={{ width: '100%' }} value={addWeight} onChange={(e) => setAddWeight(e.target.value)} />
                <div className="field-hint">用于系统合并 UEI 的加权口径；默认 1。</div>
              </div>
            </Modal>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
