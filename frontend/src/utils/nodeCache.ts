import type { Node, NodeGroup, Domain, Connection } from '@/types'

const CACHE_KEY_PREFIX = 'mindmap_canvas_cache_'
const CACHE_VERSION = 'v4' // Updated to remove drawings
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface CanvasCacheData {
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
  timestamp: number
  version: string
}

/**
 * Save canvas data to localStorage cache
 */
export function saveToCache(canvasId: number, data: {
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
}): void {
  try {
    const cacheData: CanvasCacheData = {
      ...data,
      timestamp: Date.now(),
      version: CACHE_VERSION
    }
    const key = CACHE_KEY_PREFIX + canvasId
    localStorage.setItem(key, JSON.stringify(cacheData))
  } catch (error) {
    // Silently fail
  }
}

/**
 * Load canvas data from localStorage cache
 * Returns null if cache doesn't exist, is expired, or has wrong version
 */
export function loadFromCache(canvasId: number): CanvasCacheData | null {
  try {
    const key = CACHE_KEY_PREFIX + canvasId
    const cached = localStorage.getItem(key)
    if (!cached) return null

    const data = JSON.parse(cached) as CanvasCacheData

    // Check if cache is expired
    const age = Date.now() - data.timestamp
    if (age > CACHE_EXPIRY_MS) {
      clearCache(canvasId)
      return null
    }

    // Check if cache version matches
    if (data.version !== CACHE_VERSION) {
      clearCache(canvasId)
      return null
    }

    return data
  } catch (error) {
    return null
  }
}

/**
 * Clear cache for a specific canvas
 */
export function clearCache(canvasId: number): void {
  try {
    const key = CACHE_KEY_PREFIX + canvasId
    localStorage.removeItem(key)
  } catch (error) {
    // Silently fail
  }
}

/**
 * Check if cache exists for a canvas and is valid
 */
export function hasCache(canvasId: number): boolean {
  const key = CACHE_KEY_PREFIX + canvasId
  const cached = localStorage.getItem(key)
  if (!cached) return false

  try {
    const data = JSON.parse(cached) as CanvasCacheData
    const age = Date.now() - data.timestamp
    
    // Check if cache is expired
    if (age > CACHE_EXPIRY_MS) {
      clearCache(canvasId)
      return false
    }

    // Check if cache version matches
    if (data.version !== CACHE_VERSION) {
      clearCache(canvasId)
      return false
    }

    return true
  } catch (error) {
    return false
  }
}

/**
 * Get cache age in milliseconds
 */
export function getCacheAge(canvasId: number): number | null {
  try {
    const key = CACHE_KEY_PREFIX + canvasId
    const cached = localStorage.getItem(key)
    if (!cached) return null

    const data = JSON.parse(cached) as CanvasCacheData
    return Date.now() - data.timestamp
  } catch (error) {
    return null
  }
}

/**
 * Clear all canvas caches
 */
export function clearAllCaches(): void {
  try {
    const keys = Object.keys(localStorage)
    const canvasCacheKeys = keys.filter(key => key.startsWith(CACHE_KEY_PREFIX))

    canvasCacheKeys.forEach(key => {
      localStorage.removeItem(key)
    })
  } catch (error) {
    // Silently fail
  }
}
