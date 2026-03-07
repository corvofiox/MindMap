/**
 * Logger utility for frontend
 * Note: In production, we should avoid console.log. This wrapper provides a
 * consistent way to handle logging and makes it easy to switch to a
 * proper logging solution later.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

function shouldLog(level: LogLevel): boolean {
  // In production, log info, errors and warnings for debugging
  if (import.meta.env.PROD) {
    return level === 'error' || level === 'warn' || level === 'info'
  }
  return true
}

export const logger = {
  info: (message: string, data?: any) => {
    if (shouldLog('info')) {
      console.info(`[INFO] ${message}`, data || '')
    }
  },
  warn: (message: string, data?: any) => {
    if (shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, data || '')
    }
  },
  error: (message: string, error?: any) => {
    if (shouldLog('error')) {
      console.error(`[ERROR] ${message}`, error || '')
    }
  },
  debug: (message: string, data?: any) => {
    if (shouldLog('debug')) {
      console.debug(`[DEBUG] ${message}`, data || '')
    }
  },
}
