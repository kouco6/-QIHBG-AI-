import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { ReviewStatusBadge } from '@/components/StatusBadge'
import { reviewsApi } from '@/services/endpoints'
import { useToast } from '@/components/Toast'

type Tab = 'before' | 'during' | 'after'

export default function ReviewWorkspacePage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const state = useAsync(() => reviewsApi.get(id), [id])
  const [tab, setTab] = useState<Tab>('before')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveNote, setArchiveNote] = useState('')

  async function transition(action: string, target: string, extra: Record<string, unknown> = {}) {
    try {
      await reviewsApi.transition(id, { action, target, ...extra })
      toast.show('阶段已推进', 'success')
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }

  async function doArchive() {
    try {
      await reviewsApi.transition(id, { action: 'archive', target: 'archived', archive_note: archiveNote })
      toast.show('评审已归档', 'success')
      setArchiveOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`归档失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="评审不存在" emptyReason="未找到该评审。">
        {(d) => (
          <>
            <PageHeader
              title={`评审 ${id}`}
              subtitle={<ReviewStatusBadge status={d.status ?? 'before'} />}
              actions={
                <>
                  <button className="btn" onClick={() => transition('start', 'during')}>推进到评审中</button>
                  <button className="btn" onClick={() => transition('finish', 'after')}>推进到评审后</button>
                  <button className="btn btn--primary" onClick={() => setArchiveOpen(true)}>归档</button>
                </>
              }
            />

            <div className="tabs">
              <button className={`tab${tab === 'before' ? ' is-active' : ''}`} onClick={() => setTab('before')}>前：问题汇总 / 初分</button>
              <button className={`tab${tab === 'during' ? ' is-active' : ''}`} onClick={() => setTab('during')}>中：争议 / 方案 / 承诺</button>
              <button className={`tab${tab === 'after' ? ' is-active' : ''}`} onClick={() => setTab('after')}>后：复算 / 签署 / 归档</button>
            </div>

            {tab === 'before' ? (
              <div className="card">
                <h2 className="card__title">问题汇总与初分</h2>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{JSON.stringify(d.before ?? { message: '暂无前阶段数据' }, null, 2)}</pre>
              </div>
            ) : null}
            {tab === 'during' ? (
              <div className="card">
                <h2 className="card__title">争议项（{d.during?.disputes?.length ?? 0}）</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.during?.disputes ?? []).map((x) => (
                    <li key={x.id}>{x.topic} — {x.status}{x.decision ? ` · 决策：${x.decision}` : ''}</li>
                  ))}
                  {(d.during?.disputes ?? []).length === 0 ? <li className="text-tertiary">暂无争议</li> : null}
                </ul>
              </div>
            ) : null}
            {tab === 'after' ? (
              <div className="card">
                <h2 className="card__title">签署（代录：actual_provider 必填）</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.signatures ?? []).map((s, i) => (
                    <li key={i}>{s.dept}：{s.signed_by ?? '未签'} {s.actual_provider ? `（实际提供人：${s.actual_provider}）` : ''}</li>
                  ))}
                  {(d.signatures ?? []).length === 0 ? <li className="text-tertiary">暂无签署</li> : null}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </AsyncBoundary>

      <Modal open={archiveOpen} title="归档评审" onClose={() => setArchiveOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setArchiveOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={doArchive}>确认归档</button>
        </>
      }>
        <label className="field__label" htmlFor="arc-note">归档确认文本</label>
        <textarea id="arc-note" className="input" style={{ width: '100%', minHeight: 70 }} value={archiveNote} onChange={(e) => setArchiveNote(e.target.value)} />
        <div className="field-hint">存在未决争议或缺少回复/签署时将阻止归档。</div>
      </Modal>
    </div>
  )
}
