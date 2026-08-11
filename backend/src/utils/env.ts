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
// B18: JWT_EXPIRES_IN 格式校验——jsonwebtoken 对非法值（如 'abc'）会在
// 登录/注册时抛错转 500，且 index.ts 启动即调用 getValidatedEnv()，
// 非法值会在启动阶段 fail-fast 暴露，而不是等用户登录时才炸。
// 合法形态: 纯秒数数字（'3600'）、ms 单位（'86400000ms'）或
// ms 包支持的时长字符串（'7d'、'12h'、'30m'、'2 days' 等）。
// R2-5: 允许小数时长（'1.5h'）——ms 包/jsonwebtoken 支持小数，B18 的
// 整数正则把合法配置 fail-fast 拒掉了。
const JWT_EXPIRES_IN_PATTERN = /^\d+(\.\d+)?\s*(ms|s|m|h|d|w|y|days?|hours?|minutes?|seconds?|weeks?|months?|years?)?$/i

export function getValidatedEnv(): EnvVars {
  validateEnvVars()

  const jwtExpiresIn = getEnv('JWT_EXPIRES_IN')
  if (jwtExpiresIn !== undefined && !JWT_EXPIRES_IN_PATTERN.test(jwtExpiresIn.trim())) {
    throw new Error(
      `Invalid JWT_EXPIRES_IN value '${jwtExpiresIn}'. ` +
      `Expected a duration like '7d', '12h', '30m', '3600' (seconds) or '86400000ms'.`,
    )
  }

  return {
    JWT_SECRET: getEnv('JWT_SECRET', true),
    JWT_EXPIRES_IN: jwtExpiresIn,
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
