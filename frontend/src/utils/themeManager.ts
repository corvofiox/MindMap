import type { Theme } from '@/types'

export function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') {
    return
  }

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

export function initThemeListener(): void {
  if (typeof window === 'undefined' || mediaQueryListener) {
    return
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  mediaQueryListener = mediaQuery

  const handleChange = (e: MediaQueryListEvent): void => {
    const root = document.documentElement
    if (e.matches) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handleChange)
  } else {
    mediaQuery.addListener(handleChange)
  }
}

export function removeThemeListener(): void {
  if (typeof window === 'undefined' || !mediaQueryListener) {
    return
  }

  const mediaQuery = mediaQueryListener

  const handleChange = (e: MediaQueryListEvent): void => {
    const root = document.documentElement
    if (e.matches) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }

  if (mediaQuery.removeEventListener) {
    mediaQuery.removeEventListener('change', handleChange)
  } else {
    mediaQuery.removeListener(handleChange)
  }

  mediaQueryListener = null
}

export function setupTheme(theme: Theme): void {
  applyTheme(theme)
  initThemeListener()
}
