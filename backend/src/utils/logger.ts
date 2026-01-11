import fs from 'fs'
import path from 'path'

const LOG_DIR = path.join(process.cwd(), '../logs')
const LOG_FILE = path.join(LOG_DIR, 'debug.log')

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

export function logToFile(message: string, data?: any) {
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    message,
    data: data ? JSON.stringify(data, null, 2) : undefined
  }

  const logLine = JSON.stringify(logEntry) + '\n'
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
