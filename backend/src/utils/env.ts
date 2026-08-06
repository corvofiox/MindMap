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

export function validateEnvVars(): void {
  getEnv('JWT_SECRET', true)
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

/**
 * #7: TRUST_PROXY 判定唯一入口——HTTP 侧（express trust proxy）与 WS 侧
 * （X-Forwarded-For 信任）必须使用同一套取值规则：仅 true/1/yes 视为开启，
 * 其余（含未设置）一律不信任。统一实现避免两侧判定漂移：某侧认
 * 'TRUE' 另一侧不认、或某侧多认一个 'on' 之类的值，都会造成
 * 限速绕过（伪造 X-Forwarded-For）或功能不一致。
 */
export function isTrustProxyEnabled(): boolean {
  const value = (process.env.TRUST_PROXY || '').toLowerCase()
  return value === 'true' || value === '1' || value === 'yes'
}
