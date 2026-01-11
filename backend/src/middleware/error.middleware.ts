import { Request, Response, NextFunction } from 'express'
import { logError } from '../utils/logger.js'

export interface AppError extends Error {
  statusCode?: number
  isOperational?: boolean
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _: NextFunction
) {
  const statusCode = err.statusCode || 500
  const message = err.message || 'Internal server error'

  logError('Request error', {
    method: req.method,
    url: req.url,
    statusCode,
    message,
    error: err
  })

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
