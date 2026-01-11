import fs from 'fs'
import path from 'path'
import { Request, Response } from 'express'

const LOGS_DIR = path.join(process.cwd(), 'logs')

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
  data?: string
}

export const writeLog = async (req: Request, res: Response) => {
  try {
    const { category, logs } = req.body

    const logFileName = `${category || 'general'}.log`
    const logFilePath = path.join(LOGS_DIR, logFileName)

    if (Array.isArray(logs)) {
      const logLines = logs.map((log: LogEntry) => {
        const logEntry = {
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level || 'info',
          message: log.message,
          data: log.data,
        }
        return JSON.stringify(logEntry)
      }).join('\n') + '\n'

      fs.appendFileSync(logFilePath, logLines, 'utf8')
    } else {
      const { message, data, timestamp, level } = req.body
      const logEntry = {
        timestamp: timestamp || new Date().toISOString(),
        level: level || 'info',
        message,
        data,
      }
      const logLine = JSON.stringify(logEntry) + '\n'
      fs.appendFileSync(logFilePath, logLine, 'utf8')
    }

    res.json({ success: true, message: 'Log written successfully' })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to write log' })
  }
}

export const getLogs = async (req: Request, res: Response) => {
  try {
    const { category } = req.params
    const logFileName = `${category || 'general'}.log`
    const logFilePath = path.join(LOGS_DIR, logFileName)

    if (!fs.existsSync(logFilePath)) {
      return res.json({ success: true, logs: [] })
    }

    const logContent = fs.readFileSync(logFilePath, 'utf8')
    const logs = logContent.split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))

    res.json({ success: true, logs })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to read logs' })
  }
}

export const clearLogs = async (req: Request, res: Response) => {
  try {
    const { category } = req.params
    const logFileName = `${category || 'general'}.log`
    const logFilePath = path.join(LOGS_DIR, logFileName)

    if (fs.existsSync(logFilePath)) {
      fs.unlinkSync(logFilePath)
    }

    res.json({ success: true, message: 'Logs cleared successfully' })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to clear logs' })
  }
}
