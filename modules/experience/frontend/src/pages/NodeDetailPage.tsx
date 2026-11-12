import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { NodeStatusBadge } from '@/components/StatusBadge'
import { projectsApi, nodesApi, artifactsApi, type NodeCard, type NodeDetail } from '@/services/endpoints'
import { NODE_BY_CODE, NODE_TRANSITIONS } from '@/constants'
import { useToast } from '@/components/Toast'

export default function NodeDetailPage() {
  const { id = '', code = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [pending, setPending] = useState<{ action: string; target: string; label: string } | null>(null)
  const [reason, setReason] = useState('')
  const [creatingKind, setCreatingKind] = useState('')

  const boardState = useAsync(() => projectsApi.board(id), [id])
  const nodeCard: NodeCard | undefined = boardState.data?.stages.flatMap((s) => s.nodes).find((n) => n.code === code)
  const spec = NODE_BY_CODE[code]

  const detailState = useAsync(
    () => (nodeCard ? nodesApi.get(nodeCard.id) : Promise.resolve(null as unknown as NodeDetail)),
    [nodeCard?.id],
  )

  const acts = nodeCard ? NODE_TRANSITIONS.filter((t) => t.source === nodeCard.status) : []

  async function createArtifact(kind: string, title: string) {
    if (!nodeCard) return
    setCreatingKind(kind)
    try {
      const created = await artifactsApi.create({
        project_id: id,
        node_id: nodeCard.id,
        kind,
        title: title || kind,
      })
      toast.show('产物已创建', 'success')
      navigate(`/artifacts/${created.id}/edit`)
    } catch (e) {
      toast.show(`创建产物失败：${(e as Error).message}`, 'error')
    } finally {
      setCreatingKind('')
    }
  }

  async function doTransition(action: string, target: string, reasonText?: string) {
    if (!nodeCard) return
    try {
      await nodesApi.transition(nodeCard.id, { action, target, reason: reasonText })
      toast.show('节点状态已更新', 'success')
      boardState.reload()
      detailState.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary
        state={boardState}
        emptyTitle="无法加载节点"
        emptyReason="找不到该项目的节点信息。"
      >
        {() => (
          <AsyncBoundary state={detailState} isEmpty={(d) => d === null}>
            {(detail) => (
              <>
                <PageHeader
                  title={`${code} · ${spec?.name ?? ''}`}
                  subtitle={spec?.scope}
                  actions={
                    <button className="btn" onClick={() => navigate(`/projects/${id}/board`)}>返回看板</button>
                  }
                />

                <div className="grid-2">
                  <section className="card">
                    <h2 className="card__title">节点概览</h2>
                    <dl className="detail-grid">
                      <dt>状态</dt><dd><NodeStatusBadge status={nodeCard?.status ?? 'not_started'} /></dd>
                      <dt>负责人</dt><dd>{spec?.owner ?? '—'}</dd>
                      <dt>协作人</dt><dd>{spec?.collaborators ?? '—'}</dd>
                      <dt>工期</dt><dd className="num">{spec?.duration_days ?? '—'} 天</dd>
                      <dt>产出物</dt><dd>{spec?.outputs ?? '—'}</dd>
                      <dt>上游依赖</dt><dd>{(spec?.upstream_deps ?? []).join('、') || '无'}</dd>
                    </dl>
                    {nodeCard?.blocked_reason ? <div className="tone-danger" style={{ marginTop: 8 }}>阻塞原因：{nodeCard.blocked_reason}</div> : null}
                  </section>

                  <section className="card">
                    <h2 className="card__title">完成条件与操作</h2>
                    <div className="text-secondary" style={{ marginBottom: 10 }}>
                      必需产物已确认且完成判定通过方可「完成」；N06 需评审通过。
                    </div>
                    <div className="row row--wrap">
                      {acts.length === 0 ? <span className="text-tertiary">当前状态无可执行操作</span> : null}
                      {acts.map((t) => (
                        <button
                          key={t.action}
                          type="button"
                          className="btn btn--primary"
                          onClick={() => {
                            if (t.requires_reason) { setPending({ action: t.action, target: t.target, label: t.label }); setReason('') }
                            else void doTransition(t.action, t.target)
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="card">
                    <h2 className="card__title">场景说明与输入</h2>
                    <p className="text-primary">{detail?.scenario ?? '（请在产物中填写具体场景与输入）'}</p>
                    <div className="text-secondary" style={{ marginTop: 8 }}>步骤：</div>
                    <p className="text-primary">{Array.isArray(detail?.steps) ? detail.steps.join('；') : (detail?.steps ?? '—')}</p>
                    <div className="text-secondary" style={{ marginTop: 8 }}>完成条件：</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(detail?.completion_conditions ?? []).map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                      {(detail?.completion_conditions ?? []).length === 0 ? <li className="text-tertiary">—</li> : null}
                    </ul>
                  </section>

                  <section className="card">
                    <h2 className="card__title">产物与问题</h2>
                    <div className="text-secondary" style={{ marginBottom: 6 }}>
                      产物（已建 {(detail?.artifact_summary ?? []).filter((x) => x.artifact_id).length} / 必需 {(detail?.artifact_summary ?? []).length}）
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(detail?.artifact_summary ?? []).map((a) => (
                        <li key={a.kind} style={{ marginBottom: 4 }}>
                          {a.artifact_id ? (
                            <a href={`/artifacts/${a.artifact_id}/edit`} onClick={(e) => { e.preventDefault(); navigate(`/artifacts/${a.artifact_id}/edit`) }}>{a.template_name}</a>
                          ) : (
                            <span className="text-tertiary">{a.template_name}</span>
                          )}
                          <span className="text-secondary"> · {a.status_label}</span>
                          {a.artifact_id ? null : (
                            <button
                              type="button"
                              className="btn"
                              style={{ height: 24, fontSize: 12, marginLeft: 8 }}
                              disabled={creatingKind === a.kind}
                              onClick={() => createArtifact(a.kind, a.template_name)}
                            >
                              {creatingKind === a.kind ? '创建中…' : '新建'}
                            </button>
                          )}
                        </li>
                      ))}
                      {(detail?.artifact_summary ?? []).length === 0 ? <li className="text-tertiary">本节点无必需产物</li> : null}
                    </ul>
                    <div className="text-secondary" style={{ margin: '10px 0 6px' }}>关联问题（{detail?.issue_stats?.total ?? 0}）</div>
                    {(detail?.issue_stats?.total ?? 0) > 0 ? (
                      <button type="button" className="btn" onClick={() => navigate(`/issues?project_id=${id}`)}>前往问题中心查看</button>
                    ) : (
                      <div className="text-tertiary">暂无关联问题</div>
                    )}
                  </section>

                  <section className="card" style={{ gridColumn: '1 / -1' }}>
                    <h2 className="card__title">历史记录</h2>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(detail?.history ?? []).map((h, i) => (
                        <li key={i}>{h.at} · {h.actor} · {h.action}</li>
                      ))}
                      {(detail?.history?.length ?? 0) === 0 ? <li className="text-tertiary">暂无历史</li> : null}
                    </ul>
                  </section>
                </div>
              </>
            )}
          </AsyncBoundary>
        )}
      </AsyncBoundary>

      <Modal
        open={pending !== null}
        title={pending?.label ?? ''}
        onClose={() => setPending(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPending(null)}>取消</button>
            <button type="button" className="btn btn--primary" disabled={!reason.trim()} onClick={() => { if (pending) void doTransition(pending.action, pending.target, reason.trim()); setPending(null) }}>确认</button>
          </>
        }
      >
        <label className="field__label" htmlFor="node-reason">原因（必填）</label>
        <textarea id="node-reason" className="input" style={{ width: '100%', minHeight: 80 }} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  )
}
