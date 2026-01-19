import { logError } from '../utils/logger.js';
export function errorHandler(err, req, res, _) {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal server error';
    logError('Request error', {
        method: req.method,
        url: req.url,
        statusCode,
        message,
        error: err
    });
    res.status(statusCode).json({
        success: false,
        error: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
