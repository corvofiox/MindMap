import { doubleCsrf } from 'csrf-csrf';
const getSecret = () => {
    const secret = process.env.CSRF_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
        throw new Error('CSRF_SECRET is required in production environment');
    }
    return secret || 'default-csrf-secret-change-in-production';
};
const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret,
    getSessionIdentifier: (req) => {
        const authReq = req;
        if (authReq.user?.id) {
            return authReq.user.id.toString();
        }
        return req.ip || 'default';
    },
    cookieName: 'x-csrf-token',
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        httpOnly: false,
        maxAge: 86400
    },
    size: 64,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS']
});
export const csrfProtectionMiddleware = doubleCsrfProtection;
export const getCsrfTokenRoute = (req, res, next) => {
    try {
        const token = generateCsrfToken(req, res);
        res.json({ success: true, token });
    }
    catch (error) {
        next(error);
    }
};
export const validateCsrfToken = (req, res, next) => {
    try {
        doubleCsrfProtection(req, res, next);
    }
    catch (error) {
        next(error);
    }
};
