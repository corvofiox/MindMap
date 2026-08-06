import fs from 'fs'
import path from 'path'
import { Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'

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

// A1: category 白名单校验——仅允许 [a-z0-9-]，从根上杜绝路径穿越
// (../ 或绝对路径都无法通过)。undefined/空值回退为 general。
const CATEGORY_PATTERN = /^[a-z0-9-]+$/
const MAX_CATEGORY_LENGTH = 64

// R4 #3: 单条日志大小上限 100KB——防止异常/恶意客户端单条写入超大内容
// （日志文件是追加写，无上限的单条会瞬间撑爆磁盘）。
const MAX_LOG_ENTRY_BYTES = 100 * 1024
// R4 #3: 单 category 日志文件大小上限 20MB——超限拒绝写入，防止无限追加。
const MAX_CATEGORY_FILE_BYTES = 20 * 1024 * 1024

function isLogFileFull(logFilePath: string): boolean {
  try {
    const stats = fs.statSync(logFilePath)
    return stats.size >= MAX_CATEGORY_FILE_BYTES
  } catch {
    return false // 文件不存在视为未满
  }
}

function resolveCategory(category: unknown): string | null {
  if (category === undefined || category === null || category === '') {
    return 'general'
  }
  if (
    typeof category !== 'string' ||
    category.length > MAX_CATEGORY_LENGTH ||
    !CATEGORY_PATTERN.test(category)
  ) {
    return null
  }
  return category
}

export const writeLog = async (req: Request, res: Response) => {
  authenticate(req, res, async () => {
    try {
      const { category, logs } = req.body ?? {}

      const safeCategory = resolveCategory(category)
      if (safeCategory === null) {
        return res.status(400).json({ success: false, error: '非法的日志分类（仅允许字母、数字和连字符）' })
      }

      const logFilePath = path.join(LOGS_DIR, `${safeCategory}.log`)

      if (Array.isArray(logs)) {
        // R5 #8: 数组元素守卫——null/数字等非对象元素会让 map 阶段
        // 抛 TypeError 落入 500，且数字/字符串会被静默包装成残缺日志。
        // 明确拒绝：元素必须是普通对象。
        if (logs.some(
          (log) => log === null || typeof log !== 'object' || Array.isArray(log)
        )) {
          return res.status(400).json({
            success: false,
            error: '日志数组元素必须是对象（不允许 null、数字等原始值）',
          })
        }
        const logLines = logs.map((log: LogEntry) => {
          const logEntry = {
            timestamp: log.timestamp || new Date().toISOString(),
            level: log.level || 'info',
            message: log.message,
            data: log.data,
          }
          return JSON.stringify(logEntry)
        })

        // R4 #3: 单条大小限制——任一超限整批拒绝，明确反馈让客户端分块重发
        for (const line of logLines) {
          if (Buffer.byteLength(line, 'utf8') > MAX_LOG_ENTRY_BYTES) {
            return res.status(400).json({ success: false, error: '单条日志超过大小限制(100KB)' })
          }
        }
        // R4 #3: category 文件大小上限——超限拒绝，防止无限追加撑爆磁盘
        if (isLogFileFull(logFilePath)) {
          return res.status(400).json({ success: false, error: '日志文件已满，拒绝写入' })
        }

        fs.appendFileSync(logFilePath, logLines.join('\n') + '\n', 'utf8')
      } else {
        const { message, data, timestamp, level } = req.body ?? {}
        const logEntry = {
          timestamp: timestamp || new Date().toISOString(),
          level: level || 'info',
          message,
          data,
        }
        const logLine = JSON.stringify(logEntry)

        // R4 #3: 单条大小限制 + category 文件大小上限
        if (Buffer.byteLength(logLine, 'utf8') > MAX_LOG_ENTRY_BYTES) {
          return res.status(400).json({ success: false, error: '单条日志超过大小限制(100KB)' })
        }
        if (isLogFileFull(logFilePath)) {
          return res.status(400).json({ success: false, error: '日志文件已满，拒绝写入' })
        }

        fs.appendFileSync(logFilePath, logLine + '\n', 'utf8')
      }

      res.json({ success: true, message: 'Log written successfully' })
    } catch (error) {
      res.status(500).json({ success: false, error: '写入日志失败' })
    }
  })
}

// 注意（R4 #12，单用户语义）：getLogs/clearLogs 保持现状——任何已认证用户
// 都可读取/清空任意 category 的日志文件，不做用户级隔离。单用户部署下日志
// 是运维辅助，可接受；若未来多用户部署需改为按用户隔离（如 category 加用户
// 前缀或独立目录）。
export const getLogs = async (req: Request, res: Response) => {
  authenticate(req, res, async () => {
    try {
      const safeCategory = resolveCategory(req.params.category)
      if (safeCategory === null) {
        return res.status(400).json({ success: false, error: '非法的日志分类（仅允许字母、数字和连字符）' })
      }

      const logFilePath = path.join(LOGS_DIR, `${safeCategory}.log`)

      if (!fs.existsSync(logFilePath)) {
        return res.json({ success: true, logs: [] })
      }

      const logContent = fs.readFileSync(logFilePath, 'utf8')
      const logs = logContent.split('\n').filter(line => line.trim()).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return { timestamp: new Date().toISOString(), level: 'info', message: line }
        }
      })

      res.json({ success: true, logs })
    } catch (error) {
      res.status(500).json({ success: false, error: '读取日志失败' })
    }
  })
}

export const clearLogs = async (req: Request, res: Response) => {
  authenticate(req, res, async () => {
    try {
      const safeCategory = resolveCategory(req.params.category)
      if (safeCategory === null) {
        return res.status(400).json({ success: false, error: '非法的日志分类（仅允许字母、数字和连字符）' })
      }

      const logFilePath = path.join(LOGS_DIR, `${safeCategory}.log`)

      if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath)
      }

      res.json({ success: true, message: 'Logs cleared successfully' })
    } catch (error) {
      res.status(500).json({ success: false, error: '清空日志失败' })
    }
  })
}
