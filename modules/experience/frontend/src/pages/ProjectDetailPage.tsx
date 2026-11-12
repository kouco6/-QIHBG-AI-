import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { NodeStatusBadge } from '@/components/StatusBadge'
import { projectsApi } from '@/services/endpoints'
import { useCurrentProject } from '@/app/CurrentProject'
import { formatDateTime, PROJECT_TYPE_LABELS } from '@/constants'
import { useToast } from '@/components/Toast'

export default function ProjectDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { setProject } = useCurrentProject()
  const state = useAsync(() => projectsApi.get(id), [id])
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')

  async function doEdit() {
    try {
      await projectsApi.patch(id, { name: editName })
      toast.show('已保存', 'success')
      setEditOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`保存失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="项目不存在" emptyReason="未找到该项目的详情，可能已被删除或编号有误。">
        {(d) => {
          if (editOpen && editName === '') setEditName(d.name)
          return (
            <>
              <PageHeader
                title={d.name}
                subtitle={`${d.system?.name ?? ''} · ${d.version_name ?? ''} · ${PROJECT_TYPE_LABELS[d.type ?? ''] ?? d.type ?? ''}`}
                actions={
                  <>
                    <button type="button" className="btn" onClick={() => { setEditName(d.name); setEditOpen(true) }}>编辑</button>
                    <button type="button" className="btn btn--primary" onClick={() => { setProject(d.id, d.name); navigate(`/projects/${d.id}/board`) }}>打开看板</button>
                  </>
                }
              />

              <div className="grid-2">
                <section className="card">
                  <h2 className="card__title">基础信息</h2>
                  <dl className="detail-grid">
                    <dt>项目类型</dt><dd>{PROJECT_TYPE_LABELS[d.type ?? ''] ?? d.type ?? '—'}</dd>
                    <dt>负责人</dt><dd>{d.owner_name ?? '—'}</dd>
                    <dt>事业部</dt><dd>{d.division_name ?? '—'}</dd>
                    <dt>当前节点</dt><dd>{d.current_node_name ?? d.current_node_code ?? '—'}</dd>
                    <dt>更新人</dt><dd>{d.updated_by_name ?? '—'}</dd>
                    <dt>更新时间</dt><dd className="num">{formatDateTime(d.updated_at)}</dd>
                    <dt>状态</dt><dd>{d.archived ? '已归档' : '进行中'}</dd>
                  </dl>
                </section>

                <section className="card">
                  <h2 className="card__title">成员与风险</h2>
                  <div className="text-secondary" style={{ marginBottom: 8 }}>成员（文本）</div>
                  <div className="text-primary">{d.members_text || '未填写'}</div>
                  <div className="text-secondary" style={{ margin: '12px 0 8px' }}>风险</div>
                  <div className="text-primary">{d.risks_text || '暂无风险记录'}</div>
                </section>

                <section className="card">
                  <h2 className="card__title">节点摘要（13 节点）</h2>
                  <div className="board" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                    {(d.node_summary ?? []).map((n) => (
                      <div className="node-card" key={n.code} onClick={() => navigate(`/projects/${d.id}/nodes/${n.code}`)}>
                        <div className="node-card__code">{n.code}</div>
                        <div className="node-card__name">{n.name}</div>
                        <div className="node-card__meta"><NodeStatusBadge status={n.status} /></div>
                      </div>
                    ))}
                    {(d.node_summary ?? []).length === 0 ? <div className="text-tertiary">暂无节点数据</div> : null}
                  </div>
                </section>

                <section className="card">
                  <h2 className="card__title">所属系统</h2>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {d.system ? (
                      <li key={d.system.id}><a href={`/systems/${d.system.id}`} onClick={(e) => { e.preventDefault(); navigate(`/systems/${d.system!.id}`) }}>{d.system.name}</a></li>
                    ) : (
                      <li className="text-tertiary">未关联系统</li>
                    )}
                  </ul>
                </section>

                <section className="card" style={{ gridColumn: '1 / -1' }}>
                  <h2 className="card__title">审计时间线</h2>
                  <ul className="timeline" style={{ margin: 0, paddingLeft: 18 }}>
                    {(d.timeline ?? []).map((t, i) => (
                      <li key={i}>
                        <span className="num text-tertiary">{formatDateTime(t.at)}</span> · {t.actor} · {t.action} — {t.summary}
                      </li>
                    ))}
                    {(d.timeline ?? []).length === 0 ? <li className="text-tertiary">暂无审计记录</li> : null}
                  </ul>
                </section>
              </div>

              <Modal open={editOpen} title="编辑项目" onClose={() => setEditOpen(false)} footer={
                <>
                  <button type="button" className="btn" onClick={() => setEditOpen(false)}>取消</button>
                  <button type="button" className="btn btn--primary" onClick={doEdit}>保存</button>
                </>
              }>
                <label className="field__label" htmlFor="edit-name">项目名称</label>
                <input id="edit-name" className="input" style={{ width: '100%' }} value={editName} onChange={(e) => setEditName(e.target.value)} />
              </Modal>
            </>
          )
        }}
      </AsyncBoundary>
    </div>
  )
}
