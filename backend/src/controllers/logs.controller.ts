import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'

export const logsRouter = Router()

const LOGS_DIR = path.join(process.cwd(), 'logs')

logsRouter.post('/', async (req, res) => {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true })

    const { timestamp, category, message, data } = req.body

    const date = new Date(timestamp)
    const dateStr = date.toISOString().split('T')[0]
    const logFilePath = path.join(LOGS_DIR, `${dateStr}.log`)

    const logEntry = {
      timestamp,
      category,
      message,
      ...(data && { data })
    }

    await fs.appendFile(logFilePath, JSON.stringify(logEntry) + '\n')

    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to write log' })
  }
})
