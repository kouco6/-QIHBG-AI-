import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'
import { authApi, settingsApi } from '@/services/auth'

/** T03：鉴权与设置 API 的请求契约（URL、Request-Id、错误传播） */

interface Recorded {
  url: string
  init: RequestInit | undefined
}

function stubFetch(status: number, body: unknown): Recorded[] {
  const calls: Recorded[] = []
  const fake = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return fake as unknown as Response
    }),
  )
  return calls
}

const ACCOUNT = {
  id: 'acc-1',
  account: 'longbin',
  name: '龙斌',
  role: 'experience_member',
  is_primary: true,
  is_active: true,
  last_login_at: null,
  created_at: '2026-10-16T05:00:00Z',
}

/** 断言请求失败并返回 ApiError（避免联合类型推断干扰断言） */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('预期抛出 ApiError，但请求成功返回')
}

describe('authApi 契约', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('login 打到 /api/v1/auth/login 并携带 Request-Id', async () => {
    const calls = stubFetch(200, { account: ACCOUNT, expires_at: '2026-10-16T17:00:00Z' })
    await authApi.login({ account: 'longbin', password: 'UeiWorkbench2026', remember: true })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/v1/auth/login')
    expect(calls[0].init?.method).toBe('POST')
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('X-Request-Id')).toBeTruthy()
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      account: 'longbin',
      password: 'UeiWorkbench2026',
      remember: true,
    })
  })

  it('setup 发送 confirm_password 字段', async () => {
    const calls = stubFetch(201, { account: ACCOUNT, expires_at: 'x' })
    await authApi.setup({ name: '龙斌', account: 'longbin', password: 'Abcd1234', confirm_password: 'Abcd1234' })
    expect(calls[0].url).toBe('/api/v1/auth/setup')
    expect(JSON.parse(String(calls[0].init?.body))).toHaveProperty('confirm_password', 'Abcd1234')
  })

  it('bootstrap 与 me 使用 GET', async () => {
    const calls = stubFetch(200, { needs_setup: false, account_count: 1, role_model: 'single-experience-member' })
    await authApi.bootstrap()
    expect(calls[0].url).toBe('/api/v1/auth/bootstrap')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
  })
})

describe('权限错误传播（T03）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('普通账号写设置 403 → ApiError 保留 code 与 request_id', async () => {
    stubFetch(403, {
      code: 'forbidden',
      message: '仅首账号可执行系统设置写操作',
      field_errors: [],
      request_id: 'rid-403',
      required_role: 'primary_account',
    })
    const err = await expectApiError(settingsApi.update('uei.clamp_zero', 'true'))
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(err.requestId).toBe('rid-403')
    expect(err.message).toContain('仅首账号')
  })

  it('未登录 401 → ApiError unauthorized', async () => {
    stubFetch(401, { code: 'unauthorized', message: '登录已失效，请重新登录', field_errors: [], request_id: 'rid-401' })
    const err = await expectApiError(authApi.me())
    expect(err.status).toBe(401)
    expect(err.code).toBe('unauthorized')
  })

  it('设置不存在 404 → ApiError not_found', async () => {
    stubFetch(404, { code: 'not_found', message: '配置项不存在：no.such.key', field_errors: [], request_id: 'rid-404' })
    const err = await expectApiError(settingsApi.update('no.such.key', 'x'))
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
  })

  it('audit-logs 携带分类与分页参数', async () => {
    const calls = stubFetch(200, { page: 2, page_size: 5, total: 0, items: [] })
    await settingsApi.auditLogs({ category: 'setting', page: 2, page_size: 5 })
    expect(calls[0].url).toContain('/api/v1/audit-logs?')
    expect(calls[0].url).toContain('category=setting')
    expect(calls[0].url).toContain('page=2')
    expect(calls[0].url).toContain('page_size=5')
  })
})
