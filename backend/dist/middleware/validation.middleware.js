import { z } from 'zod';
export function validateBody(schema) {
    return async (req, res, next) => {
        try {
            req.body = await schema.parseAsync(req.body);
            next();
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: '验证错误',
                    details: error.errors,
                });
            }
            next(error);
        }
    };
}
export function validateQuery(schema) {
    return async (req, res, next) => {
        try {
            req.query = await schema.parseAsync(req.query);
            next();
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: '验证错误',
                    details: error.errors,
                });
            }
            next(error);
        }
    };
}
export function validateParams(schema) {
    return async (req, res, next) => {
        try {
            req.params = await schema.parseAsync(req.params);
            next();
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: '验证错误',
                    details: error.errors,
                });
            }
            next(error);
        }
    };
}
