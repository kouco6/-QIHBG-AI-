/**
 * 鉴权与设置 API 客户端（T03）。
 * 后端契约：/api/v1/auth/*、/api/v1/accounts、/api/v1/settings、/api/v1/audit-logs
 */

import { api } from './api'

export interface Account {
  id: string
  account: string
  name: string
  role: string
  is_primary: boolean
  is_active: boolean
  last_login_at: string | null
  created_at: string | null
}

export interface BootstrapStatus {
  needs_setup: boolean
  account_count: number
  role_model: string
}

export interface AuthResult {
  account: Account
  expires_at: string
}

export interface SessionRow {
  id: string
  created_at: string
  last_seen_at: string
  expires_at: string
  user_agent: string
  ip_address: string
  current: boolean
}

export interface SettingRow {
  key: string
  value: string
  value_type: string
  description: string
  updated_by: string | null
  updated_at: string | null
}

export interface AuditRow {
  id: string
  category: string
  action: string
  actor_name: string
  actor_role: string
  target_type: string
  target_id: string
  summary: string
  detail: string
  request_id: string
  created_at: string | null
}

export interface AuditPage {
  page: number
  page_size: number
  total: number
  items: AuditRow[]
}

export const authApi = {
  bootstrap: () => api.get<BootstrapStatus>('/auth/bootstrap'),
  setup: (payload: { name: string; account: string; password: string; confirm_password: string }) =>
    api.post<AuthResult>('/auth/setup', payload),
  login: (payload: { account: string; password: string; remember?: boolean }) =>
    api.post<AuthResult>('/auth/login', payload),
  logout: () => api.post<{ message: string }>('/auth/logout'),
  me: () => api.get<Account>('/auth/me'),
  sessions: () => api.get<SessionRow[]>('/auth/sessions'),
  changePassword: (payload: { current_password: string; new_password: string; confirm_password: string }) =>
    api.post<{ message: string }>('/auth/password', payload),
}

export const accountsApi = {
  list: () => api.get<Account[]>('/accounts'),
  create: (payload: { name: string; account: string; password: string }) =>
    api.post<Account>('/accounts', payload),
  setStatus: (id: string, isActive: boolean) =>
    api.patch<Account>(`/accounts/${id}/status`, { is_active: isActive }),
}

export const settingsApi = {
  list: () => api.get<SettingRow[]>('/settings'),
  update: (key: string, value: string) => api.patch<SettingRow>(`/settings/${key}`, { value }),
  auditLogs: (params: { category?: string; page?: number; page_size?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.category) q.set('category', params.category)
    q.set('page', String(params.page ?? 1))
    q.set('page_size', String(params.page_size ?? 20))
    return api.get<AuditPage>(`/audit-logs?${q.toString()}`)
  },
}
