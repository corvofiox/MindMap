import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Project } from '@/types'
import { getSystemTheme, applyTheme, initThemeListener, removeThemeListener, setupTheme } from '@/utils/themeManager'
import { getRecentProjects, addRecentProject, clearRecentProjects, formatRelativeTime } from '@/utils/recentProjects'
import { clearAllStorage, clearAuthStorage, clearCanvasCache } from '@/utils/clearStorage'
import { debugLogger } from '@/utils/debugLogger'
import { logger } from '@/utils/logger'

/**
 * utils 纯函数/存储类工具的测试。全部只 mock 真正的外部：
 * window.matchMedia、localStorage、fetch、Date.now（fake timers）、logger 的 console 出口。
 * 被测模块本身一律真实导入。
 *
 * 踩过的坑（写在报告里，也在测试里钉住）：
 * 测试夹具 src/test/setup.ts 把 window.localStorage 换成了一个**普通对象**mock，
 * 因此 `Object.keys(localStorage)` 返回的是方法名而不是存储键。
 * clearStorage.ts 的 clearAllStorage / clearCanvasCache 全靠这个枚举工作，
 * 在夹具默认 mock 下是彻底的 no-op（实测键一个都没删）。
 * 所以下面用 defineProperty 换成一个"可枚举的 Web Storage 替身"来测这两个函数，
 * 并且专门留一条用例证明夹具 mock 下它们无效——那是这个坑的可回归证据。
 */

/** 可枚举的 Web Storage 替身（Proxy 让 Object.keys 返回真实存储键） */
interface StorageLike {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
  clear: () => void
  key: (i: number) => string | null
  readonly length: number
}

interface FakeStorage {
  proxy: StorageLike
  /** 覆盖某个方法（Proxy 的 get 会优先返回这里的实现） */
  override: (name: string, fn: unknown) => void
}

function createEnumerableStorage(): FakeStorage {
  const store = new Map<string, string>()
  const overrides = new Map<string, unknown>()
  const methods: Record<string, unknown> = {
    getItem: (k: string) => (store.has(String(k)) ? store.get(String(k))! : null),
    setItem: (k: string, v: string) => {
      store.set(String(k), String(v))
    },
    removeItem: (k: string) => {
      store.delete(String(k))
    },
    clear: () => {
      store.clear()
    },
    key: (i: number) => Array.from(store.keys())[Number(i)] ?? null,
  }
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (typeof prop === 'string' && overrides.has(prop)) return overrides.get(prop)
      if (prop === 'length') return target.size
      if (typeof prop === 'string' && prop in methods) return methods[prop]
      if (typeof prop === 'string') return target.get(prop) ?? undefined
      return undefined
    },
    set(target, prop, value) {
      if (typeof prop === 'string') {
        target.set(prop, String(value))
        return true
      }
      return false
    },
    has(target, prop) {
      return prop === 'length' || prop in methods || target.has(String(prop))
    },
    ownKeys(target) {
      return Array.from(target.keys())
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && target.has(prop)) {
        return { value: target.get(prop), enumerable: true, configurable: true, writable: true }
      }
      return undefined
    },
  }) as unknown as StorageLike

  return {
    proxy,
    override: (name, fn) => overrides.set(name, fn),
  }
}

function installStorage(storage: StorageLike) {
  Object.defineProperty(window, 'localStorage', { configurable: true, writable: true, value: storage })
}

function useRealStorage() {
  const fake = createEnumerableStorage()
  installStorage(fake.proxy)
  return fake
}

/** setup.ts 装的原始夹具 mock，用例结束后还原，避免污染同文件其它 describe */
const harnessLocalStorage = window.localStorage
function restoreHarnessStorage() {
  installStorage(harnessLocalStorage as unknown as StorageLike)
}

// ---------------------------------------------------------------- themeManager

describe('themeManager', () => {
  const originalMatchMedia = window.matchMedia

  let lastMql: { handlers: Array<(e: { matches: boolean }) => void>; matches: boolean }

  function stubMatchMedia(matches: boolean) {
    lastMql = { handlers: [], matches }
    const mql = {
      media: '(prefers-color-scheme: dark)',
      get matches() {
        return lastMql.matches
      },
      addEventListener: (_t: string, h: (e: { matches: boolean }) => void) => {
        lastMql.handlers.push(h)
      },
      removeEventListener: (_t: string, h: (e: { matches: boolean }) => void) => {
        const i = lastMql.handlers.indexOf(h)
        if (i >= 0) lastMql.handlers.splice(i, 1)
      },
      onchange: null,
      dispatchEvent: () => true,
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => mql as unknown as MediaQueryList,
    })
    return mql
  }

  const fireSystemChange = (matches: boolean) => {
    lastMql.matches = matches
    lastMql.handlers.slice().forEach((h) => h({ matches }))
  }

  beforeEach(() => {
    removeThemeListener()
    document.documentElement.className = ''
  })

  afterEach(() => {
    removeThemeListener()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
  })

  it('getSystemTheme 真的读 matchMedia 的 matches（系统深色 → dark）', () => {
    stubMatchMedia(true)
    expect(getSystemTheme()).toBe('dark')
    stubMatchMedia(false)
    expect(getSystemTheme()).toBe('light')
  })

  it('getSystemTheme 查询的是 prefers-color-scheme: dark', () => {
    const seen: string[] = []
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => {
        seen.push(q)
        return { matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList
      },
    })
    getSystemTheme()
    expect(seen).toEqual(['(prefers-color-scheme: dark)'])
  })

  it('applyTheme dark 加 .dark，light 移除 .dark', () => {
    stubMatchMedia(false)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('applyTheme system 跟随系统：深色加 .dark，浅色移除', () => {
    stubMatchMedia(true)
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    stubMatchMedia(false)
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('applyTheme 不累积/不破坏其它 class', () => {
    stubMatchMedia(false)
    document.documentElement.className = 'keepme'
    applyTheme('dark')
    expect(document.documentElement.classList.contains('keepme')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('keepme')).toBe(true)
  })

  it('initThemeListener 注册 change，系统翻深时跟随；removeThemeListener 后再翻不响应', () => {
    stubMatchMedia(false)
    applyTheme('system')
    initThemeListener()
    expect(lastMql.handlers.length).toBe(1)

    fireSystemChange(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    fireSystemChange(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    removeThemeListener()
    expect(lastMql.handlers.length).toBe(0)
    fireSystemChange(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('重复 initThemeListener 不重复注册（同一 handler 引用，removeEventListener 才有效）', () => {
    stubMatchMedia(false)
    initThemeListener()
    initThemeListener()
    initThemeListener()
    expect(lastMql.handlers.length).toBe(1)
    removeThemeListener()
    expect(lastMql.handlers.length).toBe(0)
  })

  it('显式 light/dark 后系统变化不再覆盖用户选择（D18 回归）', () => {
    stubMatchMedia(false)
    setupTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(lastMql.handlers.length).toBe(1)

    fireSystemChange(false)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    applyTheme('light')
    fireSystemChange(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    applyTheme('system')
    fireSystemChange(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removeThemeListener 在未 init 时不抛错', () => {
    stubMatchMedia(false)
    removeThemeListener()
    removeThemeListener()
    expect(lastMql.handlers.length).toBe(0)
  })

  it('setupTheme = applyTheme + 注册监听', () => {
    stubMatchMedia(true)
    setupTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(lastMql.handlers.length).toBe(1)
  })
})

// ------------------------------------------------------------- recentProjects

describe('recentProjects', () => {
  const KEY = 'mindmap_recent_projects'

  const project = (over: Partial<Project> = {}): Project =>
    ({
      id: 1,
      name: '项目一',
      description: null,
      ownerId: 7,
      groupId: null,
      thumbnail: null,
      isPublic: false,
      isCollaborative: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as Project

  beforeEach(() => {
    useRealStorage()
    localStorage.clear()
  })

  afterEach(() => {
    restoreHarnessStorage()
  })

  it('空存储返回空数组（不抛错）', () => {
    expect(getRecentProjects()).toEqual([])
  })

  it('addRecentProject 写入完整字段并落到同一个 key', () => {
    addRecentProject(project({ id: 11, name: 'Alpha', description: 'desc', isCollaborative: true, memberRole: 'editor' }))
    const list = getRecentProjects()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(11)
    expect(list[0].name).toBe('Alpha')
    expect(list[0].description).toBe('desc')
    expect(list[0].isCollaborative).toBe(true)
    expect(list[0].memberRole).toBe('editor')
    expect(typeof list[0].visitedAt).toBe('number')
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')[0].id).toBe(11)
  })

  it('memberRole 缺省时补 owner', () => {
    addRecentProject(project({ id: 12 }))
    expect(getRecentProjects()[0].memberRole).toBe('owner')
  })

  it('重复访问同一项目：去重并移到最前，name 取最新', () => {
    addRecentProject(project({ id: 1, name: 'first' }))
    addRecentProject(project({ id: 2, name: 'second' }))
    addRecentProject(project({ id: 1, name: 'renamed' }))
    const list = getRecentProjects()
    expect(list.map((p) => p.id)).toEqual([1, 2])
    expect(list[0].name).toBe('renamed')
  })

  it('最多保留 5 条，挤出最旧的', () => {
    for (let i = 1; i <= 7; i++) addRecentProject(project({ id: i, name: 'p' + i }))
    const list = getRecentProjects()
    expect(list.map((p) => p.id)).toEqual([7, 6, 5, 4, 3])
  })

  it('过滤掉超过 30 天的记录', () => {
    const now = Date.now()
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 1, name: 'fresh', isCollaborative: false, memberRole: 'owner', visitedAt: now - 29 * 86400000 },
        { id: 2, name: 'stale', isCollaborative: false, memberRole: 'owner', visitedAt: now - 31 * 86400000 },
        { id: 3, name: 'now', isCollaborative: false, memberRole: 'owner', visitedAt: now },
      ]),
    )
    expect(getRecentProjects().map((p) => p.id)).toEqual([1, 3])
  })

  it('损坏 JSON / 非数组内容都返回空数组而不是抛错', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getRecentProjects()).toEqual([])
    localStorage.setItem(KEY, 'undefined')
    expect(getRecentProjects()).toEqual([])
    localStorage.setItem(KEY, '')
    expect(getRecentProjects()).toEqual([])
    // 合法 JSON 但不是数组：filter 不存在 → 抛错被 catch 吞掉 → []
    localStorage.setItem(KEY, '{"a":1}')
    expect(getRecentProjects()).toEqual([])
    localStorage.setItem(KEY, 'null')
    expect(getRecentProjects()).toEqual([])
  })

  it('clearRecentProjects 删掉整个 key', () => {
    addRecentProject(project({ id: 5 }))
    expect(localStorage.getItem(KEY)).not.toBeNull()
    clearRecentProjects()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getRecentProjects()).toEqual([])
  })

  it('写入时也会先清理过期项（不会让过期记录无限堆积）', () => {
    const now = Date.now()
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 99, name: 'stale', isCollaborative: false, memberRole: 'owner', visitedAt: now - 40 * 86400000 },
      ]),
    )
    addRecentProject(project({ id: 1 }))
    const stored = JSON.parse(localStorage.getItem(KEY) || '[]')
    expect(stored.map((p: { id: number }) => p.id)).toEqual([1])
  })

  it('localStorage 抛错时静默失败（不炸调用方）', () => {
    const broken = createEnumerableStorage()
    broken.override('setItem', () => {
      throw new Error('QuotaExceeded')
    })
    installStorage(broken.proxy)
    expect(() => addRecentProject(project({ id: 1 }))).not.toThrow()
    restoreHarnessStorage()
  })
})

describe('formatRelativeTime（fake timers 固定时钟）', () => {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  beforeEach(() => {
    vi.useFakeTimers()
    // 用本地时间构造"现在"，让 >7 天分支的 M/D 期望与机器时区无关
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('一分钟以内是"刚刚"', () => {
    expect(formatRelativeTime(Date.now())).toBe('刚刚')
    expect(formatRelativeTime(Date.now() - 59_000)).toBe('刚刚')
  })

  it('分钟档向下取整，60s 正好进位', () => {
    expect(formatRelativeTime(Date.now() - 60_000)).toBe('1分钟前')
    expect(formatRelativeTime(Date.now() - 119_000)).toBe('1分钟前')
    expect(formatRelativeTime(Date.now() - 120_000)).toBe('2分钟前')
    expect(formatRelativeTime(Date.now() - 59 * MIN)).toBe('59分钟前')
  })

  it('小时档', () => {
    expect(formatRelativeTime(Date.now() - HOUR)).toBe('1小时前')
    expect(formatRelativeTime(Date.now() - 2 * HOUR)).toBe('2小时前')
    expect(formatRelativeTime(Date.now() - 23 * HOUR)).toBe('23小时前')
  })

  it('天档', () => {
    expect(formatRelativeTime(Date.now() - DAY)).toBe('1天前')
    expect(formatRelativeTime(Date.now() - 25 * HOUR)).toBe('1天前')
    expect(formatRelativeTime(Date.now() - 6 * DAY)).toBe('6天前')
  })

  it('超过 7 天改为 M/D（本地时间，跨月也是 M/D）', () => {
    expect(formatRelativeTime(new Date(2026, 2, 7, 12).getTime())).toBe('3/7')
    expect(formatRelativeTime(new Date(2026, 1, 20, 12).getTime())).toBe('2/20')
  })

  it('未来时间戳也返回"刚刚"（diff 为负走第一个分支）', () => {
    expect(formatRelativeTime(Date.now() + 10 * DAY)).toBe('刚刚')
  })
})

// --------------------------------------------------------------- clearStorage

describe('clearStorage', () => {
  const keys = () => Object.keys(localStorage)

  beforeEach(() => {
    useRealStorage()
    localStorage.clear()
  })

  afterEach(() => {
    restoreHarnessStorage()
  })

  it('clearAllStorage 删掉 token/auth/projects/settings/画布缓存，保留无关键', () => {
    localStorage.setItem('mindmap_token', 't')
    localStorage.setItem('mindmap-auth', 'a')
    localStorage.setItem('projects-storage', 'p')
    localStorage.setItem('mindmap-settings', 's')
    localStorage.setItem('mindmap_canvas_cache_1', 'c1')
    localStorage.setItem('mindmap_canvas_cache_42', 'c2')
    localStorage.setItem('mindmap_other', 'keep')
    localStorage.setItem('unrelated', 'keep2')

    clearAllStorage()

    expect(keys()).toEqual(['mindmap_other', 'unrelated'])
    expect(localStorage.getItem('mindmap_token')).toBeNull()
    expect(localStorage.getItem('mindmap_canvas_cache_42')).toBeNull()
  })

  it('clearAuthStorage 只删三个鉴权相关键，不动 settings 与画布缓存', () => {
    localStorage.setItem('mindmap_token', 't')
    localStorage.setItem('mindmap-auth', 'a')
    localStorage.setItem('projects-storage', 'p')
    localStorage.setItem('mindmap-settings', 's')
    localStorage.setItem('mindmap_canvas_cache_1', 'c1')

    clearAuthStorage()

    expect(keys()).toEqual(['mindmap-settings', 'mindmap_canvas_cache_1'])
  })

  it('clearCanvasCache 只删带前缀的缓存键', () => {
    localStorage.setItem('mindmap_canvas_cache_1', 'a')
    localStorage.setItem('mindmap_canvas_cache_2', 'b')
    localStorage.setItem('mindmap_token', 't')
    localStorage.setItem('mindmap_canvas_cacheX', 'edge')

    clearCanvasCache()

    expect(keys()).toEqual(['mindmap_token', 'mindmap_canvas_cacheX'])
  })

  it('空存储时三个函数都不抛错', () => {
    expect(() => clearAllStorage()).not.toThrow()
    expect(() => clearAuthStorage()).not.toThrow()
    expect(() => clearCanvasCache()).not.toThrow()
    expect(keys()).toEqual([])
  })

  it('localStorage.removeItem 抛错时被 catch 吞掉并在 DEV 下 logger.warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const broken = createEnumerableStorage()
    installStorage(broken.proxy)
    localStorage.setItem('mindmap_token', 't')
    localStorage.setItem('mindmap_canvas_cache_1', 'c')
    broken.override('removeItem', () => {
      throw new Error('SecurityError')
    })

    expect(() => clearAuthStorage()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith('Failed to clear auth storage')
    expect(() => clearCanvasCache()).not.toThrow()
    expect(() => clearAllStorage()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith('Failed to clear canvas cache')
    expect(warnSpy).toHaveBeenCalledWith('Failed to clear localStorage')
    warnSpy.mockRestore()
    restoreHarnessStorage()
  })

  it('夹具默认的不可枚举 localStorage mock 下 clearAllStorage 是 no-op（P1 回归证据）', () => {
    // 复现 src/test/setup.ts 的那个普通对象 mock：Object.keys 返回方法名而非存储键。
    const store: Record<string, string> = {}
    installStorage({
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = String(v)
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: () => null,
    } as unknown as StorageLike)

    localStorage.setItem('mindmap_token', 't')
    localStorage.setItem('mindmap_canvas_cache_1', 'c1')

    clearAllStorage()

    // 键还在 —— 这就是为什么在这种夹具下测不到清理路径，必须换成可枚举替身
    expect(localStorage.getItem('mindmap_token')).toBe('t')
    expect(localStorage.getItem('mindmap_canvas_cache_1')).toBe('c1')
    expect(Object.keys(localStorage)).toContain('getItem')
  })
})

// ---------------------------------------------------------------- debugLogger

describe('debugLogger（DEV 环境下真实行为）', () => {
  let info: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    useRealStorage()
    localStorage.clear()
    debugLogger.clearLogs()
  })

  afterEach(() => {
    info.mockRestore()
    error.mockRestore()
    warn.mockRestore()
    vi.unstubAllGlobals()
    debugLogger.clearLogs()
    restoreHarnessStorage()
  })

  it('isDev 为真（否则下面所有用例都测不到写入路径）', () => {
    expect(import.meta.env.DEV).toBe(true)
    expect((debugLogger as unknown as { isDev: boolean }).isDev).toBe(true)
  })

  it('info 生成带时间戳/级别/分类/数据的日志行，并转发给 logger.info', () => {
    debugLogger.info('auth', 'login ok', { userId: 3 })
    const logs = debugLogger.getLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[auth\] login ok \{"userId":3\}$/)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(logs[0])
  })

  it('无 data 时行尾不带 JSON', () => {
    debugLogger.warn('net', 'slow')
    expect(debugLogger.getLogs()[0]).toMatch(/\[WARN\] \[net\] slow$/)
  })

  it('四个级别都写进 entries，level 字段正确', () => {
    debugLogger.error('c', 'e')
    debugLogger.warn('c', 'w')
    debugLogger.info('c', 'i')
    debugLogger.debug('c', 'd')
    expect(debugLogger.getLogEntries().map((e: { level: string }) => e.level)).toEqual(['error', 'warn', 'info', 'debug'])
    expect(debugLogger.getLogs()).toHaveLength(4)
  })

  it('每条日志同步落到 localStorage 的 debugLogs（JSON 数组）', () => {
    debugLogger.info('persist', 'hello', { a: 1 })
    const stored = JSON.parse(localStorage.getItem('debugLogs') || '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual({ level: 'info', category: 'persist', message: 'hello', data: { a: 1 }, timestamp: expect.any(String) })
  })

  it('存储里只保留最后 500 条，内存里保留全部', () => {
    for (let i = 0; i < 510; i++) debugLogger.info('cat' + i, 'msg' + i)
    const stored = JSON.parse(localStorage.getItem('debugLogs') || '[]')
    expect(stored).toHaveLength(500)
    expect(stored[0].category).toBe('cat10')
    expect(stored[499].category).toBe('cat509')
    expect(debugLogger.getLogs()).toHaveLength(510)
  })

  it('getLogs/getLogEntries 返回副本，外部改不动内部状态', () => {
    debugLogger.info('c', 'm')
    debugLogger.getLogs().push('tampered')
    debugLogger.getLogEntries().push({ tampered: true })
    expect(debugLogger.getLogs()).toHaveLength(1)
    expect(debugLogger.getLogEntries()).toHaveLength(1)
    expect(debugLogger.getLogs()[0]).toContain('[c] m')
  })

  it('clearLogs 清内存 + 清 localStorage', () => {
    debugLogger.info('c', 'm')
    expect(localStorage.getItem('debugLogs')).not.toBeNull()
    debugLogger.clearLogs()
    expect(debugLogger.getLogs()).toEqual([])
    expect(debugLogger.getLogEntries()).toEqual([])
    expect(localStorage.getItem('debugLogs')).toBeNull()
  })

  it('debugLogs 里是坏 JSON 时不抛错，但也不会自愈（写入一直失败）', () => {
    // 实测：log() 里 JSON.parse 失败 → catch → logger.error，坏值留在存储里，
    // 内存日志仍然累积。只有 clearLogs 能恢复。
    localStorage.setItem('debugLogs', '{broken')
    expect(() => debugLogger.info('c', 'm')).not.toThrow()

    expect(localStorage.getItem('debugLogs')).toBe('{broken')
    expect(error).toHaveBeenCalledWith('Failed to save log to localStorage', expect.any(Error))
    expect(debugLogger.getLogs()).toHaveLength(1)

    debugLogger.clearLogs()
    debugLogger.info('c2', 'm2')
    expect(JSON.parse(localStorage.getItem('debugLogs') || '[]')).toHaveLength(1)
  })

  describe('saveToServer', () => {
    it('POST /api/logs，带 category 与内存里的日志，返回解析后的 JSON', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          return { ok: true, status: 200, statusText: 'OK', json: async () => ({ saved: 2 }) }
        }),
      )

      debugLogger.info('svc', 'one')
      debugLogger.warn('svc', 'two')
      const result = await debugLogger.saveToServer('mycat')

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('/api/logs')
      expect(calls[0].init.method).toBe('POST')
      const body = JSON.parse(String(calls[0].init.body))
      expect(body.category).toBe('mycat')
      expect(body.logs).toHaveLength(2)
      expect(body.logs[0].message).toBe('one')
      expect(result).toEqual({ saved: 2 })
    })

    it('默认 category 是 frontend', async () => {
      let sent: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          sent = JSON.parse(String(init.body))
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        }),
      )
      debugLogger.info('c', 'm')
      await debugLogger.saveToServer()
      expect(sent.category).toBe('frontend')
    })

    it('没有日志时完全不发请求', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
      vi.stubGlobal('fetch', fetchMock)
      localStorage.removeItem('debugLogs')
      const out = await debugLogger.saveToServer()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(out).toBeUndefined()
      expect(warn).toHaveBeenCalledWith('No logs to save')
    })

    it('内存为空但 localStorage 有历史时会用存储里的日志（getLogsFromStorage 路径）', async () => {
      localStorage.setItem(
        'debugLogs',
        JSON.stringify([{ timestamp: 't1', level: 'info', category: 'fromStorage', message: 'm1' }]),
      )
      let sent: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          sent = JSON.parse(String(init.body))
          return { ok: true, status: 200, json: async () => ({ saved: 1 }) }
        }),
      )
      await debugLogger.saveToServer()
      expect((sent.logs as Array<{ category: string }>).map((l) => l.category)).toEqual(['fromStorage'])
    })

    it('响应非 2xx 时抛出带状态码的错误，并补一条 log-save 失败日志', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) })),
      )
      debugLogger.info('svc', 'x')
      await expect(debugLogger.saveToServer()).rejects.toThrow('Failed to save logs: 403 Forbidden')
      const last = debugLogger.getLogs()[debugLogger.getLogs().length - 1]
      expect(last).toContain('[ERROR] [log-save] Failed to save logs to server')
    })

    it('fetch 直接 reject 时向上抛出（不吞错误）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('network down')
        }),
      )
      debugLogger.info('svc', 'x')
      await expect(debugLogger.saveToServer()).rejects.toThrow('network down')
      expect(error).toHaveBeenCalled()
    })
  })
})
