interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  data?: any
}

class DebugLogger {
  private logs: LogEntry[] = []
  private maxLogs = 50
  private category = 'canvas'
  private flushTimer: NodeJS.Timeout | null = null
  private flushDelay = 5000
  private isEnabled = process.env.NODE_ENV !== 'production'

  private safeStringify(obj: any): string {
    const seen = new WeakSet()
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]'
        }
        seen.add(value)
      }
      if (value instanceof HTMLElement) {
        return `[HTMLElement: ${value.tagName}]`
      }
      if (value instanceof Error) {
        return `[Error: ${value.message}]`
      }
      return value
    })
  }

  private formatMessage(entry: LogEntry): string {
    const dataStr = entry.data ? ` | Data: ${this.safeStringify(entry.data)}` : ''
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${dataStr}`
  }

  async log(level: LogEntry['level'], message: string, data?: any) {
    if (!this.isEnabled) return

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    }

    this.logs.push(entry)

    if (this.logs.length > this.maxLogs) {
      this.logs.shift()
    }

    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.flushTimer) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flush()
      this.flushTimer = null
    }, this.flushDelay)
  }

  async flush() {
    if (this.logs.length === 0) return

    try {
      const logsToFlush = this.logs.map(entry => ({
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        data: entry.data ? this.safeStringify(entry.data) : undefined
      }))

      await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          category: this.category,
          logs: logsToFlush,
        }),
      })

      this.logs = []
    } catch (error) {
      // Silently fail
    }
  }

  info(message: string, data?: any) {
    this.log('info', message, data)
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data)
  }

  error(message: string, data?: any) {
    this.log('error', message, data)
  }

  debug(message: string, data?: any) {
    this.log('debug', message, data)
  }
}

const debugLogger = new DebugLogger()

export { debugLogger }
