import fs from 'fs'
import path from 'path'

const LOG_DIR = path.join(process.cwd(), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'debug.log')

// B21: 文件大小轮转——debug.log 超过阈值时依次滚动为 debug.log.1/.2，
// 保留最近 MAX_LOG_FILES 份，防止单文件无限增长撑爆磁盘。
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_LOG_FILES = 3

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

/**
 * Roll the log file over when it exceeds MAX_LOG_SIZE_BYTES:
 * debug.log → debug.log.1 → debug.log.2 → (oldest dropped).
 * Best-effort: rotation failures must never break logging.
 */
function rotateLogFileIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return
    const { size } = fs.statSync(LOG_FILE)
    if (size < MAX_LOG_SIZE_BYTES) return
    // Shift backups from newest to oldest so rename never overwrites a file
    // that has not been moved yet.
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`
      const to = `${LOG_FILE}.${i}`
      if (fs.existsSync(from)) {
        fs.renameSync(from, to)
      }
    }
  } catch {
    // best-effort: keep writing to the current file
  }
}

export function logToFile(message: string, data?: any) {
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    message,
    data: data ? JSON.stringify(data, null, 2) : undefined
  }

  const logLine = JSON.stringify(logEntry) + '\n'
  rotateLogFileIfNeeded()
  fs.appendFileSync(LOG_FILE, logLine, 'utf-8')
}

export function logError(message: string, error?: any) {
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    level: 'ERROR',
    message,
    error: error ? (error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : JSON.stringify(error, null, 2)) : undefined
  }

  const logLine = JSON.stringify(logEntry) + '\n'
  rotateLogFileIfNeeded()
  fs.appendFileSync(LOG_FILE, logLine, 'utf-8')
}

export const log = logToFile

export function clearLogFile() {
  if (fs.existsSync(LOG_FILE)) {
    fs.unlinkSync(LOG_FILE)
  }
}

export function readLogFile(): string {
  if (fs.existsSync(LOG_FILE)) {
    return fs.readFileSync(LOG_FILE, 'utf-8')
  }
  return 'No log file found'
}
