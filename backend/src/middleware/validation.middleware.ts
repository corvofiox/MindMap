import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = await schema.parseAsync(req.body)
      next()
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: '验证错误',
          details: error.errors,
        })
      }
      next(error)
    }
  }
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = await schema.parseAsync(req.query) as any
      next()
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: '验证错误',
          details: error.errors,
        })
      }
      next(error)
    }
  }
}

export function validateParams<T>(schema: z.ZodSchema<T>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.params = await schema.parseAsync(req.params) as any
      next()
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: '验证错误',
          details: error.errors,
        })
      }
      next(error)
    }
  }
}
