import type { Theme } from '@/types'

export function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// 当前生效的主题：applyTheme 每次调用都会更新，mediaQuery 回调据此判断
// 是否跟随系统（D18：显式 light/dark 时不再被系统主题变化覆盖）。
let currentTheme: Theme = 'system'

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') {
    return
  }

  currentTheme = theme

  const root = document.documentElement
  let isDark: boolean

  if (theme === 'system') {
    isDark = getSystemTheme() === 'dark'
  } else {
    isDark = theme === 'dark'
  }

  if (isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

let mediaQueryListener: MediaQueryList | null = null

// 统一的 change 处理函数：init/remove 使用同一引用，确保 removeEventListener 生效（D18）
const handleMediaQueryChange = (e: MediaQueryListEvent): void => {
  // 仅当用户选择“跟随系统”时才响应系统主题变化
  if (currentTheme !== 'system') return

  const root = document.documentElement
  if (e.matches) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export function initThemeListener(): void {
  if (typeof window === 'undefined' || mediaQueryListener) {
    return
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  mediaQueryListener = mediaQuery

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handleMediaQueryChange)
  } else {
    mediaQuery.addListener(handleMediaQueryChange)
  }
}

export function removeThemeListener(): void {
  if (typeof window === 'undefined' || !mediaQueryListener) {
    return
  }

  const mediaQuery = mediaQueryListener

  if (mediaQuery.removeEventListener) {
    mediaQuery.removeEventListener('change', handleMediaQueryChange)
  } else {
    mediaQuery.removeListener(handleMediaQueryChange)
  }

  mediaQueryListener = null
}

export function setupTheme(theme: Theme): void {
  applyTheme(theme)
  initThemeListener()
}
