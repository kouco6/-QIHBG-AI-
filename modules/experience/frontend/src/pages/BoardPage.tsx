import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { NodeStatusBadge } from '@/components/StatusBadge'
import { projectsApi, nodesApi, type NodeCard } from '@/services/endpoints'
import { NODE_TRANSITIONS, STAGES } from '@/constants'
import { useToast } from '@/components/Toast'

export default function BoardPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => projectsApi.board(id), [id])
  const [pending, setPending] = useState<{ node: NodeCard; action: string; target: string; label: string } | null>(null)
  const [reason, setReason] = useState('')

  const allowed = useMemo(() => {
    const map: Record<string, typeof NODE_TRANSITIONS> = {}
    return (status: string) => {
      if (!map[status]) map[status] = NODE_TRANSITIONS.filter((t) => t.source === status) as unknown as typeof NODE_TRANSITIONS
      return map[status]
    }
  }, [])

  async function doTransition(node: NodeCard, action: string, target: string, reasonText?: string) {
    try {
      await nodesApi.transition(node.id, { action, target, reason: reasonText })
      toast.show('节点状态已更新', 'success')
      state.reload()
    } catch (e) {
      const msg = (e as Error).message
      toast.show(`操作失败：${msg}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader title="阶段看板" subtitle="四阶段泳道 × 13 节点卡；非法迁移已禁用并说明原因" actions={
        <button className="btn" onClick={() => navigate(`/projects/${id}`)}>返回项目</button>
      } />

      <AsyncBoundary state={state} emptyTitle="看板不可用" emptyReason="无法加载该项目的阶段看板。">
        {(board) => (
          <div className="board" style={{ gridTemplateColumns: 'repeat(4, minmax(240px, 1fr))' }}>
            {STAGES.map((stage) => {
              const lane = board.stages.find((s) => s.code === stage.code)
              const nodes = lane?.nodes ?? []
              return (
                <div className="board__lane" key={stage.code}>
                  <div className="board__lane-title"><span>{stage.name}</span><span className="text-tertiary">{nodes.length}</span></div>
                  {nodes.map((n) => {
                    const acts = allowed(n.status)
                    return (
                      <div className="node-card" key={n.id} onClick={() => navigate(`/projects/${id}/nodes/${n.code}`)}>
                        <div className="node-card__code">{n.code}</div>
                        <div className="node-card__name">{n.name}</div>
                        <div className="node-card__meta">
                          <NodeStatusBadge status={n.status} />
                        </div>
                        <div className="text-tertiary" style={{ fontSize: 12, marginTop: 4 }}>
                          工期 {n.duration_days ?? '—'} 天 · 产物 {n.artifact_count ?? 0}
                        </div>
                        {n.blocked_reason ? <div className="tone-danger" style={{ fontSize: 12, marginTop: 4 }}>阻塞：{n.blocked_reason}</div> : null}
                        <div className="row" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                          {acts.length === 0 ? <span className="text-tertiary" style={{ fontSize: 12 }}>无可执行操作</span> : null}
                          {acts.map((t) => (
                            <button
                              key={t.action}
                              type="button"
                              className="btn"
                              style={{ height: 26, fontSize: 12 }}
                              title={t.label}
                              onClick={() => {
                                if (t.requires_reason) {
                                  setPending({ node: n, action: t.action, target: t.target, label: t.label })
                                  setReason('')
                                } else {
                                  void doTransition(n, t.action, t.target)
                                }
                              }}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </AsyncBoundary>

      <Modal
        open={pending !== null}
        title={pending?.label ?? ''}
        onClose={() => setPending(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPending(null)}>取消</button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!reason.trim()}
              onClick={() => {
                if (pending) void doTransition(pending.node, pending.action, pending.target, reason.trim())
                setPending(null)
              }}
            >
              确认
            </button>
          </>
        }
      >
        <label className="field__label" htmlFor="na-reason">原因（必填）</label>
        <textarea id="na-reason" className="input" style={{ width: '100%', minHeight: 80 }} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  )
}
