import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { IssueStatusBadge } from '@/components/StatusBadge'
import { issuesApi } from '@/services/endpoints'
import { BUSINESS_LEVEL_LABELS, SEVERITY_LABELS, fmt1 } from '@/constants'
import { useToast } from '@/components/Toast'

export default function IssueDetailPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const state = useAsync(() => issuesApi.get(id), [id])
  const [replyOpen, setReplyOpen] = useState(false)
  const [reply, setReply] = useState({ content: '', actual_provider: '', version: '' })

  async function transition(action: string, target: string, reason?: string) {
    try {
      await issuesApi.transition(id, { action, target, reason })
      toast.show('状态已更新', 'success')
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }
  async function onSave() {
    try {
      await issuesApi.patch(id, {})
      toast.show('已保存', 'success')
    } catch (e) {
      toast.show(`保存失败：${(e as Error).message}`, 'error')
    }
  }
  async function submitReply() {
    if (!reply.actual_provider.trim()) { toast.show('代录实际提供人必填', 'warning'); return }
    try {
      // 录制事业部回复：后端要求 actual_provider 必填
      await issuesApi.transition(id, { action: 'record_reply', target: 'in_progress', reason: reply.content })
      toast.show('已录回复（代录）', 'success')
      setReplyOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`录回复失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="问题不存在" emptyReason="未找到该问题。">
        {(d) => (
          <>
            <PageHeader
              title={d.description}
              subtitle={<IssueStatusBadge status={d.status} />}
              actions={
                <>
                  <button className="btn" onClick={onSave}>保存</button>
                  <button className="btn" onClick={() => transition('submit', 'pending_confirm')}>提交确认</button>
                  <button className="btn btn--primary" onClick={() => setReplyOpen(true)}>录回复</button>
                  <button className="btn" onClick={() => transition('accept', 'accepted')}>验收通过</button>
                  <button className="btn" onClick={() => toast.show('已同步至 Mock 飞书', 'info')}>同步</button>
                </>
              }
            />

            <div className="grid-2">
              <section className="card">
                <h2 className="card__title">基础分类</h2>
                <dl className="detail-grid">
                  <dt>业务等级</dt><dd>{BUSINESS_LEVEL_LABELS[d.business_level ?? ''] ?? d.business_level ?? '—'}</dd>
                  <dt>问题等级</dt><dd>{SEVERITY_LABELS[d.severity ?? ''] ?? d.severity ?? '—'}</dd>
                  <dt>指标</dt><dd>{d.metric_name ?? '—'}</dd>
                  <dt>来源</dt><dd>{d.source ?? '—'}</dd>
                  <dt>责任人</dt><dd>{d.owner_name ?? '—'}</dd>
                </dl>
                {d.source_artifact ? (
                  <div className="text-tertiary" style={{ marginTop: 8 }}>来源产物：{d.source_artifact.title}（{d.source_artifact.kind}）</div>
                ) : null}
              </section>

              <section className="card">
                <h2 className="card__title">矩阵命中预览</h2>
                {d.matrix_preview ? (
                  <dl className="detail-grid">
                    <dt>命中单元</dt><dd>{d.matrix_preview.cell}</dd>
                    <dt>扣分</dt><dd className="num">{fmt1(d.matrix_preview.deduction)}</dd>
                  </dl>
                ) : (
                  <div className="text-tertiary">暂无矩阵命中数据</div>
                )}
              </section>

              <section className="card">
                <h2 className="card__title">回复与承诺（代录）</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.replies ?? []).map((r, i) => (
                    <li key={i}>{r.content} {r.actual_provider ? `· 实际提供人：${r.actual_provider}` : ''} {r.at ? `· ${r.at}` : ''}</li>
                  ))}
                  {(d.replies ?? []).length === 0 ? <li className="text-tertiary">暂无回复</li> : null}
                </ul>
                {(d.commitments ?? []).length > 0 ? (
                  <div className="text-secondary" style={{ marginTop: 8 }}>承诺版本：{d.commitments?.map((c) => c.version).join('、')}</div>
                ) : null}
              </section>

              <section className="card">
                <h2 className="card__title">验收</h2>
                <div>结论：{d.acceptance?.conclusion ?? '—'}</div>
                <div className="text-tertiary" style={{ marginTop: 4 }}>证据：{d.acceptance?.evidence ?? '—'}</div>
                {d.acceptance?.conclusion ? <div className="text-tertiary" style={{ marginTop: 4 }}>（该问题已验收，状态为只读）</div> : null}
              </section>

              <section className="card" style={{ gridColumn: '1 / -1' }}>
                <h2 className="card__title">状态时间线</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.timeline ?? []).map((t, i) => (
                    <li key={i}>{t.at} · {t.actor} · {t.action} — {t.summary}</li>
                  ))}
                  {(d.timeline ?? []).length === 0 ? <li className="text-tertiary">暂无时间线</li> : null}
                </ul>
              </section>
            </div>

            <Modal open={replyOpen} title="录回复（代录）" onClose={() => setReplyOpen(false)} footer={
              <>
                <button className="btn" onClick={() => setReplyOpen(false)}>取消</button>
                <button className="btn btn--primary" onClick={submitReply}>提交代录</button>
              </>
            }>
              <div className="field">
                <label className="field__label" htmlFor="r-content">回复内容</label>
                <textarea id="r-content" className="input" style={{ width: '100%', minHeight: 70 }} value={reply.content} onChange={(e) => setReply((r) => ({ ...r, content: e.target.value }))} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="r-provider">实际提供人<span className="req">*</span></label>
                <input id="r-provider" className="input" style={{ width: '100%' }} value={reply.actual_provider} onChange={(e) => setReply((r) => ({ ...r, actual_provider: e.target.value }))} />
                <div className="field-hint">代录必须填写实际提供人，代录人与时间由系统生成。</div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="r-ver">承诺/实际版本</label>
                <input id="r-ver" className="input" style={{ width: '100%' }} value={reply.version} onChange={(e) => setReply((r) => ({ ...r, version: e.target.value }))} />
              </div>
            </Modal>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
