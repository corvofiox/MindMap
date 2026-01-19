export function getEnv(name, required) {
    const isRequired = required !== undefined ? required : true;
    const value = process.env[name];
    if (isRequired && !value) {
        throw new Error(`Required environment variable '${name}' is not set. ` +
            `Please set it in your .env file or environment.`);
    }
    return value;
}
export function validateEnvVars() {
    getEnv('JWT_SECRET', true);
    const jwtExpiresIn = getEnv('JWT_EXPIRES_IN');
    if (!jwtExpiresIn) {
        console.warn('Warning: JWT_EXPIRES_IN not set, using default (7d)');
    }
}
export function getValidatedEnv() {
    validateEnvVars();
    return {
        JWT_SECRET: getEnv('JWT_SECRET', true),
        JWT_EXPIRES_IN: getEnv('JWT_EXPIRES_IN'),
        PORT: getEnv('PORT'),
        WS_PORT: getEnv('WS_PORT'),
        DB_FILE: getEnv('DB_FILE'),
        ALLOWED_ORIGINS: getEnv('ALLOWED_ORIGINS'),
        NODE_ENV: getEnv('NODE_ENV'),
    };
}
