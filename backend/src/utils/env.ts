/**
 * Environment Variable Validation
 *
 * This module validates that all required environment variables are set
 * and throws errors early if any are missing.
 */

export interface EnvVars {
  JWT_SECRET: string
  JWT_EXPIRES_IN?: string
  PORT?: string
  WS_PORT?: string
  DB_FILE?: string
  ALLOWED_ORIGINS?: string
  NODE_ENV?: string
}

/**
 * Get environment variable with validation
 * @param name - Environment variable name
 * @param required - Whether to variable is required (default: true)
 * @returns The environment variable value
 * @throws Error if required variable is missing
 */
export function getEnv(
  name: keyof EnvVars,
  required?: boolean
): string | undefined {
  const isRequired = required !== undefined ? required : true
  const value = process.env[name]

  if (isRequired && !value) {
    throw new Error(
      `Required environment variable '${name}' is not set. ` +
      `Please set it in your .env file or environment.`
    )
  }

  return value
}

/**
 * Validate all required environment variables on startup
 * Call this at the beginning of your application initialization
 */
export function validateEnvVars(): void {
  getEnv('JWT_SECRET', true)

  // Warn about optional vars if not set
  const jwtExpiresIn = getEnv('JWT_EXPIRES_IN')
  if (!jwtExpiresIn) {
    console.warn('Warning: JWT_EXPIRES_IN not set, using default (7d)')
  }

  // DB_FILE is optional, DATABASE_URL is not required
}

/**
 * Get all validated environment variables
 */
export function getValidatedEnv(): EnvVars {
  validateEnvVars()

  return {
    JWT_SECRET: getEnv('JWT_SECRET', true),
    JWT_EXPIRES_IN: getEnv('JWT_EXPIRES_IN'),
    PORT: getEnv('PORT'),
    WS_PORT: getEnv('WS_PORT'),
    DB_FILE: getEnv('DB_FILE'),
    ALLOWED_ORIGINS: getEnv('ALLOWED_ORIGINS'),
    NODE_ENV: getEnv('NODE_ENV'),
  }
}
