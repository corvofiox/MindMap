import cors from 'cors';
export const createCorsMiddleware = (env) => {
    let cachedAllowedOrigins = null;
    const parseAllowedOrigins = () => {
        if (cachedAllowedOrigins)
            return cachedAllowedOrigins;
        const allowed = env.ALLOWED_ORIGINS?.trim();
        let origins = [];
        if (!allowed) {
            origins = env.NODE_ENV === 'development'
                ? ['http://localhost:5173', 'http://127.0.0.1:5173']
                : [];
        }
        else {
            origins = allowed === '*' ? ['*'] : allowed.split(',').map(o => o.trim());
        }
        cachedAllowedOrigins = origins;
        return origins;
    };
    const isDevEnv = env.NODE_ENV === 'development';
    return cors({
        origin: (origin, callback) => {
            if (!origin) {
                return callback(null, true);
            }
            const allowedOrigins = parseAllowedOrigins();
            if (allowedOrigins.includes('*')) {
                return callback(null, true);
            }
            if (isDevEnv && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173')) {
                return callback(null, true);
            }
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            const errorMsg = `Origin ${origin} not allowed by CORS`;
            console.warn(errorMsg);
            return callback(new Error(errorMsg));
        },
        credentials: true,
        methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
        allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-csrf-token'],
        exposedHeaders: ['X-CSRF-Token'],
        maxAge: 86400
    });
};
