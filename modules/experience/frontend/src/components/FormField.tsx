import { cloneElement, isValidElement, useEffect, useRef, type ReactElement, type ReactNode } from 'react'

/** 表单字段容器：必填用星号 + 文字，错误信息即时显示在字段下方并与控件读屏关联（DESIGN §6.2.3） */
export function FormField({
  label,
  required,
  error,
  hint,
  htmlFor,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  hint?: string
  htmlFor?: string
  children: ReactNode
}) {
  const errorId = error && htmlFor ? `${htmlFor}-error` : undefined
  const hintId = hint && !error && htmlFor ? `${htmlFor}-hint` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  const child =
    isValidElement(children) && describedBy
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-invalid': Boolean(error) || undefined,
          'aria-describedby': describedBy,
        })
      : children
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="req">*</span> : null}
      </label>
      {child}
      {hint && !error ? <div className="field-hint" id={hintId}>{hint}</div> : null}
      {error ? (
        <div className="field__error" id={errorId} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/** 提交错误摘要：出现时自动聚焦，条目可链接回字段（DESIGN §6.2.3） */
export function ErrorSummary({
  errors,
  anchorId,
  items,
}: {
  errors: string[]
  anchorId?: string
  items?: Array<{ message: string; fieldId?: string }>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const signature = errors.join('|')
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  if (errors.length === 0) return null
  const rows: Array<{ message: string; fieldId?: string }> = items ?? errors.map((message) => ({ message }))
  return (
    <div className="error-summary" id={anchorId} tabIndex={-1} ref={ref} role="alert" aria-label="表单校验错误">
      请修正以下问题后重试：
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {rows.map((row, i) => (
          <li key={`${row.message}-${i}`}>
            {row.fieldId ? (
              <a
                href={`#${row.fieldId}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(row.fieldId as string)?.focus()
                }}
              >
                {row.message}
              </a>
            ) : (
              row.message
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
