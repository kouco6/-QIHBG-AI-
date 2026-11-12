/**
 * API 客户端：统一 /api/v1 前缀、统一错误形状、Request-Id 贯穿。
 * 后端错误形状：{ code, message, field_errors, request_id }（见 backend/app/core/errors.py）
 */

export interface ApiErrorBody {
  code: string
  message: string
  field_errors: Array<{ field: string; message: string; type?: string }>
  request_id: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fieldErrors: ApiErrorBody['field_errors']
  readonly requestId: string

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.message ?? `请求失败（HTTP ${status}）`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code ?? 'http_error'
    this.fieldErrors = body.field_errors ?? []
    this.requestId = body.request_id ?? ''
  }
}

const API_PREFIX = '/api/v1'

function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  return `rid-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestId = newRequestId()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Request-Id', requestId)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const resp = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  })

  if (!resp.ok) {
    let body: Partial<ApiErrorBody> = {}
    try {
      body = (await resp.json()) as ApiErrorBody
    } catch {
      body = { message: await resp.text().catch(() => '') }
    }
    throw new ApiError(resp.status, { ...body, request_id: body.request_id || requestId })
  }

  if (resp.status === 204) {
    return undefined as T
  }
  return (await resp.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export interface HealthResponse {
  status: string
  app: string
  version: string
  env: string
  database: { ok: boolean; detail: string }
  provider: {
    configured_mode: string
    effective_mode: string
    feishu_configured: boolean
    ai_configured: boolean
  }
}

export const systemApi = {
  /** 健康检查走 /api/health（不在 /api/v1 下） */
  health: async (): Promise<HealthResponse> => {
    const resp = await fetch('/api/health', { headers: { Accept: 'application/json' } })
    if (!resp.ok) {
      throw new ApiError(resp.status, { message: '后端健康检查失败' })
    }
    return (await resp.json()) as HealthResponse
  },
  meta: () => api.get<Record<string, unknown>>('/meta'),
}
