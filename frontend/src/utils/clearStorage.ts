const STORAGE_KEYS = {
  TOKEN: 'mindmap_token',
  AUTH: 'mindmap-auth',
  PROJECTS: 'projects-storage',
  SETTINGS: 'mindmap-settings',
  CANVAS_CACHE_PREFIX: 'mindmap_canvas_cache_',
} as const

function logWarning(message: string) {
  if (import.meta.env.DEV) {
    console.warn(`[WARN] ${message}`)
  }
}

export function clearAllStorage(): void {
  if (typeof window === 'undefined') return

  try {
    const keys = Object.keys(window.localStorage)

    for (const key of keys) {
      if (
        key === STORAGE_KEYS.TOKEN ||
        key === STORAGE_KEYS.AUTH ||
        key === STORAGE_KEYS.PROJECTS ||
        key === STORAGE_KEYS.SETTINGS ||
        key.startsWith(STORAGE_KEYS.CANVAS_CACHE_PREFIX)
      ) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    logWarning('Failed to clear localStorage')
  }
}

export function clearAuthStorage(): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(STORAGE_KEYS.TOKEN)
    window.localStorage.removeItem(STORAGE_KEYS.AUTH)
    window.localStorage.removeItem(STORAGE_KEYS.PROJECTS)
  } catch {
    logWarning('Failed to clear auth storage')
  }
}

export function clearCanvasCache(): void {
  if (typeof window === 'undefined') return

  try {
    const keys = Object.keys(window.localStorage)

    for (const key of keys) {
      if (key.startsWith(STORAGE_KEYS.CANVAS_CACHE_PREFIX)) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    logWarning('Failed to clear canvas cache')
  }
}
