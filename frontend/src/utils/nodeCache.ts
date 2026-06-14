import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { logger } from '@/utils/logger'

const CACHE_KEY_PREFIX = 'mindmap_canvas_cache_'
const CACHE_VERSION = 'v4' // Updated to remove drawings
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * P4: tab 级 sessionId，用于画布缓存 key 隔离。
 * 同账号多标签页编辑同一画布时，若共用同一 localStorage key 会互相覆盖缓存，
 * 导致较早标签页的未保存编辑丢失。加 sessionId 后每个标签页独立缓存。
 * 整个 tab 生命周期固定，与 collabService 的 sessionId 思路一致。
 */
let tabSessionId: string | null = null
function getTabSessionId(): string {
  if (!tabSessionId) {
    const g = globalThis as { crypto?: { randomUUID?: () => string } }
    tabSessionId = (g.crypto?.randomUUID)
      ? g.crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
  return tabSessionId
}

function getCacheKey(canvasId: number): string {
  return `${CACHE_KEY_PREFIX}${canvasId}_${getTabSessionId()}`
}

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
    const key = getCacheKey(canvasId)
    localStorage.setItem(key, JSON.stringify(cacheData))
  } catch (error) {
    logger.warn('Failed to save canvas cache to localStorage', { canvasId, error })
  }
}

/**
 * Load canvas data from localStorage cache
 * Returns null if cache doesn't exist, is expired, or has wrong version
 */
export function loadFromCache(canvasId: number): CanvasCacheData | null {
  try {
    const key = getCacheKey(canvasId)
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
    const key = getCacheKey(canvasId)
    localStorage.removeItem(key)
  } catch (error) {
    logger.warn('Failed to clear canvas cache from localStorage', { canvasId, error })
  }
}

/**
 * Check if cache exists for a canvas and is valid
 */
export function hasCache(canvasId: number): boolean {
  const key = getCacheKey(canvasId)
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
    const key = getCacheKey(canvasId)
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
    logger.warn('Failed to clear all canvas caches from localStorage', error)
  }
}
