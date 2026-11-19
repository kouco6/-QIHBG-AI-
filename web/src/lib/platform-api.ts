export async function platformApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new PlatformApiError(value?.message || value?.error || `请求失败（${response.status}）`, response.status)
  return value as T
}

export type PlatformAccount = { id: string; name: string; login: string; role: "admin" | "user"; tags: string[]; active: boolean; modules: string[]; must_change_password: boolean }
export class PlatformApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.name = "PlatformApiError"; this.status = status }
}

