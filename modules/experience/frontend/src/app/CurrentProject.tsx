import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { projectsApi, type ProjectRow } from '@/services/endpoints'

interface CurrentProjectValue {
  projectId: string | null
  projectName: string | null
  setProject: (id: string, name: string) => void
  recent: ProjectRow[]
  reloadRecent: () => void
}

const STORAGE_KEY = 'uei.currentProject'
const CurrentProjectContext = createContext<CurrentProjectValue | null>(null)

export function CurrentProjectProvider({ children }: { children: React.ReactNode }) {
  const [stored, setStored] = useState<{ id: string; name: string } | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as { id: string; name: string }) : null
    } catch {
      return null
    }
  })
  const [recent, setRecent] = useState<ProjectRow[]>([])

  const reloadRecent = useCallback(() => {
    projectsApi
      .list({ page_size: 12 })
      .then((p) => setRecent(p.items))
      .catch(() => {})
  }, [])

  useEffect(() => {
    reloadRecent()
  }, [reloadRecent])

  const setProject = useCallback((id: string, name: string) => {
    setStored({ id, name })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, name }))
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<CurrentProjectValue>(
    () => ({
      projectId: stored?.id ?? null,
      projectName: stored?.name ?? null,
      setProject,
      recent,
      reloadRecent,
    }),
    [stored, recent, setProject, reloadRecent],
  )

  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>
}

export function useCurrentProject(): CurrentProjectValue {
  const ctx = useContext(CurrentProjectContext)
  if (!ctx) return { projectId: null, projectName: null, setProject: () => {}, recent: [], reloadRecent: () => {} }
  return ctx
}
