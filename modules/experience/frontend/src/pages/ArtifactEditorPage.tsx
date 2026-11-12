import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { FormField } from '@/components/FormField'
import { Modal } from '@/components/Modal'
import { useAsync } from '@/hooks/useAsync'
import { ArtifactStatusBadge } from '@/components/StatusBadge'
import { artifactsApi, type ArtifactDetail } from '@/services/endpoints'
import { useGlobalHotkeys } from '@/hooks/useHotkeys'
import { useToast } from '@/components/Toast'

interface FieldDef {
  key: string
  label: string
  required?: boolean
  type?: string
  columns?: string[]
}
interface Group { group: string; fields: FieldDef[] }

/** 表格 / 勾选式字段的一行：列名 → 值 */
type RowValue = Record<string, string>

type DialogState =
  | { kind: 'return'; field: 'reason'; label: string; hint: string }
  | { kind: 'resume'; field: 'reason'; label: string; hint: string }
  | { kind: 'resume'; field: 'change_note'; label: string; hint: string }

const ROW_TYPES = new Set(['table', 'checklist'])

function extractGroups(d: ArtifactDetail): Group[] {
  if (d.field_groups && d.field_groups.length) return d.field_groups
  if (d.template?.groups) return d.template.groups
  if (d.fields) {
    return [
      {
        group: '内容',
        fields: d.fields.map((f) => ({
          key: f.key,
          label: f.label,
          required: f.required,
          type: f.type,
          columns: f.columns,
        })),
      },
    ]
  }
  return [{ group: '内容', fields: [{ key: 'content', label: '内容', required: false }] }]
}

/** 行式字段编辑器：表格字段必须按行录入，纯文本无法通过后端「至少 1 行」校验。 */
function RowsEditor({
  fieldKey,
  columns,
  rows,
  onChange,
  onBlur,
}: {
  fieldKey: string
  columns: string[]
  rows: RowValue[]
  onChange: (rows: RowValue[]) => void
  onBlur: () => void
}) {
  const blank = () => Object.fromEntries(columns.map((c) => [c, '']))
  const update = (index: number, col: string, value: string) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, [col]: value } : r)))
  }

  return (
    <div>
      <div className="table-wrap">
        <table className="data-table" aria-label={`${fieldKey} 明细`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th style={{ width: 88 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="text-tertiary">
                  尚未录入行，点击「添加一行」开始。
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>
                      <input
                        className="input"
                        data-field={fieldKey}
                        data-row={i}
                        data-col={c}
                        aria-label={`第 ${i + 1} 行 ${c}`}
                        value={row[c] ?? ''}
                        onChange={(e) => update(i, c, e.target.value)}
                        onBlur={onBlur}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="btn" onClick={() => onChange(rows.filter((_, x) => x !== i))}>
                      删除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn" data-add-row={fieldKey} onClick={() => onChange([...rows, blank()])}>
          添加一行
        </button>
      </div>
    </div>
  )
}

export default function ArtifactEditorPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const state = useAsync(() => artifactsApi.get(id), [id])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [title, setTitle] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'pending'>('idle')
  const [dirty, setDirty] = useState(false)
  const [collaborators, setCollaborators] = useState('')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogText, setDialogText] = useState('')
  const timer = useRef<number | undefined>(undefined)

  const groups = state.data ? extractGroups(state.data) : []
  const requiredKeys = groups.flatMap((g) => g.fields.filter((f) => f.required).map((f) => f.key))

  const filled = (key: string) => {
    const v = values[key]
    if (Array.isArray(v)) {
      return v.some((row) => row && typeof row === 'object' && Object.values(row as RowValue).some((x) => String(x ?? '').trim()))
    }
    return String(v ?? '').trim().length > 0
  }
  const firstRequiredMet = requiredKeys.slice(0, 8).every(filled)

  // 打开/重新加载后把服务端字段值灌入受控状态（后端值在 current_version.payload）
  useEffect(() => {
    const d = state.data
    if (!d) return
    const init: Record<string, unknown> = {}
    for (const f of d.fields ?? []) init[f.key] = f.value ?? ''
    setValues(init)
    setTitle(d.title ?? '')
    setCollaborators(d.collaborators_text ?? '')
  }, [state.data])

  const saveDraft = useCallback(
    async (showToast = false) => {
      if (!state.data) return
      setSaveState('saving')
      try {
        // 标题/协作人走 PATCH（仅草稿可改）；字段值走 PUT /draft 的 payload（键值对，行式字段为数组）
        if (state.data.status === 'draft') {
          await artifactsApi.patch(id, { title, collaborators_text: collaborators })
        }
        await artifactsApi.saveDraft(id, { payload: values })
        setSaveState('saved')
        setDirty(false)
        if (showToast) toast.show('草稿已自动保存', 'info')
      } catch (e) {
        setSaveState('pending')
        if (showToast) toast.show(`自动保存失败：${(e as Error).message}`, 'error')
      }
    },
    [id, state.data, title, collaborators, values, toast],
  )

  // 30 秒自动保存
  useEffect(() => {
    if (!state.data) return
    timer.current = window.setInterval(() => {
      if (saveState !== 'saving') void saveDraft(false)
    }, 30000)
    return () => { if (timer.current) window.clearInterval(timer.current) }
  }, [state.data, saveState, saveDraft])

  useGlobalHotkeys({ onSave: () => void saveDraft(true) })

  // 离开提醒：存在未保存改动时，关闭/刷新页面前由浏览器确认
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '有未保存的改动，确定离开吗？'
      return e.returnValue
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  function markDirty() {
    setDirty(true)
    setSaveState('pending')
  }

  function onBlurField() {
    setSaveState('pending')
    void saveDraft(false)
  }

  async function onSubmit() {
    try {
      await artifactsApi.submit(id)
      toast.show('产物已提交', 'success')
      setDirty(false)
      state.reload()
    } catch (e) {
      toast.show(`提交失败：${(e as Error).message}`, 'error')
    }
  }

  async function onConfirm() {
    try {
      await artifactsApi.confirm(id)
      toast.show('产物已确认', 'success')
      state.reload()
    } catch (e) {
      toast.show(`确认失败：${(e as Error).message}`, 'error')
    }
  }

  function openDialog(next: DialogState) {
    setDialogText('')
    setDialog(next)
  }

  async function onDialogSubmit() {
    if (!dialog) return
    const text = dialogText.trim()
    if (!text) {
      toast.show(`请填写${dialog.label}`, 'warning')
      return
    }
    try {
      if (dialog.kind === 'return') {
        await artifactsApi.returnArtifact(id, text)
        toast.show('产物已退回', 'success')
      } else if (dialog.field === 'change_note') {
        await artifactsApi.resume(id, { change_note: text })
        toast.show('已按确认版复制为新版本', 'success')
      } else {
        await artifactsApi.resume(id, { reason: text })
        toast.show('已恢复为草稿', 'success')
      }
      setDialog(null)
      state.reload()
    } catch (e) {
      toast.show(`${dialog.kind === 'return' ? '退回' : '恢复'}失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div>
      <AsyncBoundary state={state} emptyTitle="产物不存在" emptyReason="未找到该产物。">
        {(d) => (
          <>
            <PageHeader
              title="产物编辑器"
              subtitle={<ArtifactStatusBadge status={d.status} />}
              actions={
                <>
                  <button className="btn" onClick={() => navigate(`/artifacts/${id}/versions`)}>版本</button>
                  <button className="btn" onClick={() => void saveDraft(true)}>保存</button>
                  {d.status === 'draft' ? (
                    <button className="btn btn--primary" onClick={onSubmit}>提交</button>
                  ) : null}
                  {d.status === 'submitted' ? (
                    <>
                      <button className="btn" onClick={() => openDialog({ kind: 'return', field: 'reason', label: '退回原因', hint: '退回后由作者修正并重新提交。' })}>退回</button>
                      <button className="btn btn--primary" onClick={onConfirm}>确认</button>
                    </>
                  ) : null}
                  {d.status === 'confirmed' ? (
                    <button className="btn" onClick={() => openDialog({ kind: 'resume', field: 'change_note', label: '变更原因', hint: '确认版不可原位修改，将按当前确认版复制出一份新草稿。' })}>复制为新版本</button>
                  ) : null}
                  {d.status === 'returned' ? (
                    <button className="btn" onClick={() => openDialog({ kind: 'resume', field: 'reason', label: '恢复原因', hint: '恢复后回到草稿，可继续编辑。' })}>恢复为草稿</button>
                  ) : null}
                </>
              }
            />

            <div className="autosave" style={{ marginBottom: 12 }}>
              <span className="autosave__dot" />
              {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已自动保存' : saveState === 'pending' ? '待保存' : '编辑中（30 秒或失焦自动保存）'}
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="form-grid">
                <div className="field">
                  <label className="field__label" htmlFor="art-title">标题</label>
                  <input id="art-title" className="input" style={{ width: '100%' }} value={title} onChange={(e) => { markDirty(); setTitle(e.target.value) }} onBlur={onBlurField} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="art-col">协作人（文本）</label>
                  <input id="art-col" className="input" style={{ width: '100%' }} value={collaborators} onChange={(e) => { markDirty(); setCollaborators(e.target.value) }} onBlur={onBlurField} />
                </div>
              </div>
            </div>

            {groups.map((g) => (
              <section className="card" key={g.group} style={{ marginBottom: 16 }}>
                <h2 className="card__title">{g.group}</h2>
                <div className="form-grid">
                  {g.fields.map((f) => {
                    const isRows = !!f.type && ROW_TYPES.has(f.type)
                    const columns = f.columns ?? []
                    const rows = Array.isArray(values[f.key]) ? (values[f.key] as RowValue[]) : []
                    return (
                      <div className="field" key={f.key} style={isRows ? { gridColumn: '1 / -1' } : undefined}>
                        {isRows ? (
                          <span className="field__label">
                            {f.label}{f.required ? <span className="req">*</span> : null}
                          </span>
                        ) : (
                          <label className="field__label" htmlFor={`f-${f.key}`}>
                            {f.label}{f.required ? <span className="req">*</span> : null}
                          </label>
                        )}
                        {isRows ? (
                          <RowsEditor
                            fieldKey={f.key}
                            columns={columns.length ? columns : ['内容']}
                            rows={rows}
                            onChange={(next) => { markDirty(); setValues((v) => ({ ...v, [f.key]: next })) }}
                            onBlur={onBlurField}
                          />
                        ) : (
                          <textarea
                            id={`f-${f.key}`}
                            className="input"
                            style={{ width: '100%', minHeight: 60 }}
                            value={String(values[f.key] ?? '')}
                            onChange={(e) => { markDirty(); setValues((v) => ({ ...v, [f.key]: e.target.value })) }}
                            onBlur={onBlurField}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}

            {!firstRequiredMet ? (
              <div className="alert alert--warn">首次提交需填写前 {Math.min(8, requiredKeys.length)} 个必填字段（当前已满足：{firstRequiredMet}）。</div>
            ) : null}
          </>
        )}
      </AsyncBoundary>

      <Modal
        open={!!dialog}
        title={dialog ? dialog.label : ''}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDialog(null)}>取消</button>
            <button className="btn btn--primary" onClick={onDialogSubmit}>确定</button>
          </>
        }
      >
        {dialog ? (
          <FormField label={dialog.label} required htmlFor="dlg-text" hint={dialog.hint}>
            <textarea
              id="dlg-text"
              className="input"
              style={{ width: '100%', minHeight: 80 }}
              value={dialogText}
              onChange={(e) => setDialogText(e.target.value)}
            />
          </FormField>
        ) : null}
      </Modal>
    </div>
  )
}
