import { logger } from './logger'
import { apiClient } from '@/services/apiClient'

class DebugLogger {
  private logsDir: string
  private logs: string[] = []
  private logEntries: any[] = []
  private isDev: boolean

  constructor() {
    this.logsDir = '/logs'
    this.isDev = import.meta.env.DEV
  }

  private ensureLogsDir() {
    if (typeof window === 'undefined') return
  }

  log(type: 'info' | 'error' | 'warn' | 'debug', category: string, message: string, data?: any) {
    // Only log in development mode
    if (!this.isDev) return
    const timestamp = new Date().toISOString()
    const logEntry = {
      timestamp,
      level: type,
      category,
      message,
      data
    }

    const logLine = `[${timestamp}] [${type.toUpperCase()}] [${category}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`
    logger.info(logLine)

    this.logs.push(logLine)
    this.logEntries.push(logEntry)

    try {
      const existingLogs = JSON.parse(localStorage.getItem('debugLogs') || '[]')
      existingLogs.push(logEntry)
      localStorage.setItem('debugLogs', JSON.stringify(existingLogs.slice(-500)))
    } catch (e) {
      logger.error('Failed to save log to localStorage', e)
    }
  }

  info(category: string, message: string, data?: any) {
    this.log('info', category, message, data)
  }

  error(category: string, message: string, data?: any) {
    this.log('error', category, message, data)
  }

  warn(category: string, message: string, data?: any) {
    this.log('warn', category, message, data)
  }

  debug(category: string, message: string, data?: any) {
    this.log('debug', category, message, data)
  }

  async saveToServer(category: string = 'frontend') {
    const logsToSend = this.logEntries.length > 0 ? this.logEntries : this.getLogsFromStorage()
    
    if (logsToSend.length === 0) {
      logger.warn('No logs to save')
      return
    }

    try {
      logger.info('Attempting to save logs to server...', { category, logCount: logsToSend.length })

      // 携带认证 + CSRF 头（D23：/api/logs 受 CSRF 保护，缺头会 403）
      const authHeaders = apiClient.getAuthHeaders('application/json') as Record<string, string>

      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          category,
          logs: logsToSend
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to save logs: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()
      logger.info('Logs saved successfully:', result)
      return result
    } catch (error) {
      logger.error('Failed to save logs to server:', error)
      this.log('error', 'log-save', 'Failed to save logs to server', { error: String(error) })
      throw error
    }
  }

  private getLogsFromStorage(): any[] {
    try {
      return JSON.parse(localStorage.getItem('debugLogs') || '[]')
    } catch {
      return []
    }
  }

  downloadLogs() {
    const allLogs = [...this.getLogsFromStorage(), ...this.logEntries]
    const logContent = allLogs.map(entry => JSON.stringify(entry)).join('\n')
    const blob = new Blob([logContent], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `debug-${Date.now()}.log`
    a.click()
    URL.revokeObjectURL(url)
    
    this.log('info', 'debug', 'Logs downloaded', { count: allLogs.length })
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  getLogEntries(): any[] {
    return [...this.logEntries]
  }

  clearLogs() {
    this.logs = []
    this.logEntries = []
    localStorage.removeItem('debugLogs')
  }
}

export const debugLogger = new DebugLogger()
