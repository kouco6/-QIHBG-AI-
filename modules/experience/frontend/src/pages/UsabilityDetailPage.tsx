import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { StudyStatusBadge } from '@/components/StatusBadge'
import { usabilityApi } from '@/services/endpoints'
import { SUS_QUESTIONS } from '@/constants'
import { useToast } from '@/components/Toast'

type Tab = 'participants' | 'tasks' | 'runs' | 'sus' | 'stats'

export default function UsabilityDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => usabilityApi.get(id), [id])
  const [tab, setTab] = useState<Tab>('participants')
  const [naOpen, setNaOpen] = useState(false)
  const [naReason, setNaReason] = useState('')

  async function markNa() {
    try {
      await usabilityApi.markNa(id, naReason)
      toast.show('已标记为不适用', 'success')
      setNaOpen(false)
      state.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }
  async function calcSus() {
    try {
      const r = await usabilityApi.calcSus(id)
      toast.show(`SUS 计算完成：${r.sus_score ?? '—'}（缺题不计入）`, 'success')
    } catch (e) {
      toast.show(`计算失败：${(e as Error).message}`, 'error')
    }
  }
  async function genReport() {
    try {
      await usabilityApi.report(id)
      toast.show('已生成结构化报告', 'success')
      state.reload()
    } catch (e) {
      toast.show(`生成失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="研究不存在" emptyReason="未找到该研究。">
        {(d) => (
          <>
            <PageHeader
              title={d.name}
              subtitle={<StudyStatusBadge status={d.status ?? 'draft'} />}
              actions={
                <>
                  <button className="btn" onClick={genReport}>生成报告</button>
                  <button className="btn" onClick={() => setNaOpen(true)}>标记不适用</button>
                  <button className="btn btn--primary" onClick={() => navigate('/usability')}>返回</button>
                </>
              }
            />

            <div className="tabs">
              {(['participants', 'tasks', 'runs', 'sus', 'stats'] as Tab[]).map((t) => (
                <button key={t} className={`tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
                  {t === 'participants' ? '参与者' : t === 'tasks' ? '任务' : t === 'runs' ? '运行记录' : t === 'sus' ? 'SUS' : '统计'}
                </button>
              ))}
            </div>

            {tab === 'participants' ? (
              <div className="card">
                <div className="row row--between"><h2 className="card__title">参与者（{d.participants?.length ?? 0}）</h2>
                  <button className="btn" onClick={() => toast.show('已添加参与者（演示）', 'info')}>批量录入</button></div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.participants ?? []).map((p) => <li key={p.id}>{p.name} {p.satisfaction !== undefined ? `· 满意度 ${p.satisfaction}/10` : ''}</li>)}
                  {(d.participants ?? []).length === 0 ? <li className="text-tertiary">暂无参与者</li> : null}
                </ul>
              </div>
            ) : null}

            {tab === 'tasks' ? (
              <div className="card">
                <div className="row row--between"><h2 className="card__title">任务（{d.tasks?.length ?? 0}）</h2>
                  <button className="btn" onClick={() => toast.show('已添加任务（演示）', 'info')}>新增任务</button></div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(d.tasks ?? []).map((t) => <li key={t.id}>{t.name}</li>)}
                  {(d.tasks ?? []).length === 0 ? <li className="text-tertiary">暂无任务</li> : null}
                </ul>
              </div>
            ) : null}

            {tab === 'runs' ? (
              <div className="card"><h2 className="card__title">运行记录矩阵</h2><div className="text-tertiary">参与者 × 任务的完成度 / 时间 / 错误 / 满意度（演示视图）。</div></div>
            ) : null}

            {tab === 'sus' ? (
              <div className="card">
                <div className="row row--between"><h2 className="card__title">SUS（十题）</h2><button className="btn btn--primary" onClick={calcSus}>计算 SUS</button></div>
                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                  {SUS_QUESTIONS.map((q, i) => <li key={i} style={{ marginBottom: 4 }}>{q}</li>)}
                </ol>
                <div className="field-hint">满意度取 1–10；任一题缺失则该份答卷不计入 SUS 计算。</div>
              </div>
            ) : null}

            {tab === 'stats' ? (
              <div className="card">
                <h2 className="card__title">统计</h2>
                {d.stats ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{JSON.stringify(d.stats, null, 2)}</pre> : <div className="text-tertiary">暂无统计数据，请先录入运行记录与 SUS。</div>}
                {d.report?.generated_at ? <div className="text-tertiary" style={{ marginTop: 8 }}>报告生成于 {d.report.generated_at}</div> : null}
              </div>
            ) : null}
          </>
        )}
      </AsyncBoundary>

      <Modal open={naOpen} title="标记不适用" onClose={() => setNaOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setNaOpen(false)}>取消</button>
          <button className="btn btn--primary" disabled={!naReason.trim()} onClick={markNa}>确认</button>
        </>
      }>
        <label className="field__label" htmlFor="na-reason">原因（必填）</label>
        <textarea id="na-reason" className="input" style={{ width: '100%', minHeight: 70 }} value={naReason} onChange={(e) => setNaReason(e.target.value)} />
      </Modal>
    </div>
  )
}
