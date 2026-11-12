import { describe, expect, it } from 'vitest'
import { ApiError } from '@/services/api'

/** T02：错误契约与 Request-Id 贯穿的基础行为 */

describe('ApiError', () => {
  it('保留后端统一错误形状的字段', () => {
    const err = new ApiError(403, {
      code: 'forbidden',
      message: '该操作仅首账号可执行',
      field_errors: [{ field: 'role', message: '权限不足' }],
      request_id: 'rid-abc',
    })
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(err.message).toBe('该操作仅首账号可执行')
    expect(err.fieldErrors).toHaveLength(1)
    expect(err.requestId).toBe('rid-abc')
  })

  it('缺省字段时给出可读默认值', () => {
    const err = new ApiError(500, {})
    expect(err.code).toBe('http_error')
    expect(err.requestId).toBe('')
    expect(err.message).toContain('500')
  })
})
