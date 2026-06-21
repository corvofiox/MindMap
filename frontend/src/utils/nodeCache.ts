import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { logger } from '@/utils/logger'

const CACHE_KEY_PREFIX = 'mindmap_canvas_cache_'
const CACHE_VERSION = 'v4' // Updated to remove drawings
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours
// localStorage 各浏览器配额约 5-10MB，预留 headroom，超过则直接跳过缓存
const MAX_CACHE_SIZE_BYTES = 4 * 1024 * 1024

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

function estimateSize(value: string): number {
  // UTF-16 字符串在 localStorage 中每个字符占 2 bytes
  return value.length * 2
}

function isQuotaExceededError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

// 避免同一画布反复触发大缓存/配额日志导致刷屏，每个 tab 会话只提示一次
const loggedOversizedCanvasIds = new Set<number>()
const loggedQuotaCanvasIds = new Set<number>()

function logOnce(canvasId: number, message: string, data: Record<string, unknown>, bucket: Set<number>): void {
  if (bucket.has(canvasId)) return
  bucket.add(canvasId)
  logger.info(message, data)
}

function isValidCacheData(data: unknown): data is CanvasCacheData {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Partial<CanvasCacheData>
  return (
    Array.isArray(d.nodes) &&
    Array.isArray(d.groups) &&
    Array.isArray(d.domains) &&
    Array.isArray(d.connections) &&
    typeof d.timestamp === 'number' &&
    typeof d.version === 'string'
  )
}

/**
 * Save canvas data to localStorage cache.
 * If the serialized data exceeds MAX_CACHE_SIZE_BYTES, skip caching silently.
 * If localStorage quota is exceeded, log an info and skip instead of warning.
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
    const payload = JSON.stringify(cacheData)
    const size = estimateSize(payload)
    if (size > MAX_CACHE_SIZE_BYTES) {
      logOnce(
        canvasId,
        'Canvas cache payload too large, skipping localStorage cache',
        { canvasId, size },
        loggedOversizedCanvasIds
      )
      return
    }

    const key = getCacheKey(canvasId)
    try {
      localStorage.setItem(key, payload)
    } catch (error) {
      if (isQuotaExceededError(error)) {
        logOnce(
          canvasId,
          'localStorage quota exceeded, skipping canvas cache',
          { canvasId, size },
          loggedQuotaCanvasIds
        )
        return
      }
      logger.warn('Failed to save canvas cache to localStorage', { canvasId, error })
    }
  } catch (error) {
    logger.warn('Failed to serialize canvas cache', { canvasId, error })
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

    const data = JSON.parse(cached)
    if (!isValidCacheData(data)) {
      clearCache(canvasId)
      return null
    }

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
  try {
    const key = getCacheKey(canvasId)
    const cached = localStorage.getItem(key)
    if (!cached) return false

    const data = JSON.parse(cached)
    if (!isValidCacheData(data)) {
      clearCache(canvasId)
      return false
    }

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

    const data = JSON.parse(cached)
    if (!isValidCacheData(data)) {
      clearCache(canvasId)
      return null
    }

    const age = Date.now() - data.timestamp
    if (age > CACHE_EXPIRY_MS || data.version !== CACHE_VERSION) {
      clearCache(canvasId)
      return null
    }

    return age
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
    logger.warn('Failed to clear all canvas caches from localStorage', { error })
  }
}
