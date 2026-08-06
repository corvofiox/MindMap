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
  let message = err.message || 'Internal server error'

  // R4 #10: multer 超限类错误（LIMIT_FILE_SIZE 等）保留 413——上传文件过大
  // 是客户端可预期的业务失败，不应被当成 500 处理；前端依赖 413 提示用户
  // 调整文件。同样保留原始语义，不进入下方生产环境 5xx 通用文案替换。
  // R5 #7: 其余 multer 错误（LIMIT_UNEXPECTED_FILE / LIMIT_FILE_COUNT /
  // LIMIT_FIELD_COUNT 等）同样是客户端请求格式问题（字段/文件数量超出
  // 预期），统一转 4xx，不能落入 500 让客户端误以为是服务端故障。
  if (err && typeof err === 'object' && 'code' in err) {
    const multerCode = (err as { code?: unknown }).code
    if (multerCode === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: '文件大小超出限制',
      })
    }
    if (typeof multerCode === 'string' && multerCode.startsWith('LIMIT_')) {
      return res.status(400).json({
        success: false,
        error: '上传请求不符合要求（文件数量或字段超出限制）',
      })
    }
  }

  // A6: 生产环境不向客户端泄露 5xx 内部错误详情（堆栈/内部路径/DB 报错等），
  // 统一返回通用文案；详情仍完整记录到服务端日志。4xx 业务错误保留原信息。
  const isProduction = process.env.NODE_ENV === 'production'
  if (statusCode >= 500 && isProduction) {
    message = '服务器内部错误'
  }

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
