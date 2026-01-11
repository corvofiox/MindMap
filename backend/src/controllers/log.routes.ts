import { Router } from 'express'
import { writeLog, getLogs, clearLogs } from './logger.controller.js'

const router = Router()

router.post('/', writeLog)
router.get('/:category', getLogs)
router.delete('/:category', clearLogs)

export const logRouter = router
