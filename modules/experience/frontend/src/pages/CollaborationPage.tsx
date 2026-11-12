import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { Modal } from '@/components/Modal'
import { collaborationApi, type ThreadDetail } from '@/services/endpoints'
import { formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

export default function CollaborationPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [active, setActive] = useState<ThreadDetail | null>(null)
  const [msg, setMsg] = useState('')

  const listState = useAsync(() => collaborationApi.list({ project_id: id }), [id])
  const activeState = useAsync(
    () => (active ? collaborationApi.get(active.id) : Promise.resolve(null as unknown as ThreadDetail)),
    [active?.id],
  )

  async function createThread() {
    if (!title.trim()) { toast.show('话题标题必填', 'warning'); return }
    try {
      const t = await collaborationApi.create({ project_id: id, title: title.trim() })
      toast.show('讨论已创建', 'success')
      setCreateOpen(false)
      setTitle('')
      listState.reload()
      setActive(t)
    } catch (e) {
      toast.show(`创建失败：${(e as Error).message}`, 'error')
    }
  }
  async function post() {
    if (!active || !msg.trim()) return
    try {
      await collaborationApi.post(active.id, { content: msg.trim() })
      setMsg('')
      setActive(null)
      activeState.reload()
      const fresh = await collaborationApi.get(active.id)
      setActive(fresh)
      toast.show('已发布', 'success')
    } catch (e) {
      toast.show(`发布失败：${(e as Error).message}`, 'error')
    }
  }
  async function closeThread() {
    if (!active) return
    try {
      await collaborationApi.close(active.id)
      toast.show('讨论已关闭（只读）', 'success')
      setActive(null)
      activeState.reload()
      listState.reload()
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <PageHeader title="协作空间" subtitle="讨论与引用实体；仅本地账号发言，协作人不获账号权限" actions={<button className="btn btn--primary" onClick={() => setCreateOpen(true)}>发起讨论</button>} />

      <div className="grid-2" style={{ gridTemplateColumns: '320px 1fr', alignItems: 'start' }}>
        <section className="card">
          <h2 className="card__title">讨论串（{listState.data?.items?.length ?? 0}）</h2>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {(listState.data?.items ?? []).map((t) => (
              <li key={t.id} className="node-card" style={{ cursor: 'pointer' }} onClick={() => setActive(t as ThreadDetail)}>
                <div className="node-card__name">{t.title}</div>
                <div className="text-tertiary" style={{ fontSize: 12 }}>{t.message_count ?? 0} 条{t.closed ? ' · 已关闭' : ''}</div>
              </li>
            ))}
            {(listState.data?.items?.length ?? 0) === 0 ? <li className="text-tertiary">暂无讨论</li> : null}
          </ul>
        </section>

        <AsyncBoundary state={listState} isEmpty={(d) => (d?.items?.length ?? 0) === 0} emptyTitle="暂无讨论">
          {() => (
            <AsyncBoundary state={activeState} isEmpty={(d) => d === null} emptyTitle="选择左侧讨论串查看消息">
              {(thread) => (
                <section className="card">
                  <div className="row row--between">
                    <h2 className="card__title">{thread.title}</h2>
                    {!thread.closed ? <button className="btn" onClick={closeThread}>关闭讨论</button> : <span className="text-tertiary">已关闭（只读）</span>}
                  </div>
                  <ul style={{ margin: '8px 0', paddingLeft: 18, maxHeight: 360, overflow: 'auto' }}>
                    {(thread.messages ?? []).map((m) => (
                      <li key={m.id} style={{ marginBottom: 8 }}>
                        <div className="text-secondary"><b>{m.author}</b> · {formatDateTime(m.at)}{m.ref_type ? ` · 引用${m.ref_type}` : ''}</div>
                        <div>{m.content}</div>
                      </li>
                    ))}
                    {(thread.messages ?? []).length === 0 ? <li className="text-tertiary">还没有消息</li> : null}
                  </ul>
                  {!thread.closed ? (
                    <div className="row" style={{ gap: 8 }}>
                      <input className="input" style={{ flex: 1 }} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="输入消息，引用问题/产物请注明编号" onKeyDown={(e) => { if (e.key === 'Enter') post() }} />
                      <button className="btn btn--primary" onClick={post} disabled={!msg.trim()}>发布</button>
                    </div>
                  ) : null}
                </section>
              )}
            </AsyncBoundary>
          )}
        </AsyncBoundary>
      </div>

      <Modal open={createOpen} title="发起讨论" onClose={() => setCreateOpen(false)} footer={
        <>
          <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="btn btn--primary" onClick={createThread}>创建</button>
        </>
      }>
        <label className="field__label" htmlFor="th-title">话题标题</label>
        <input id="th-title" className="input" style={{ width: '100%' }} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Modal>
    </div>
  )
}
