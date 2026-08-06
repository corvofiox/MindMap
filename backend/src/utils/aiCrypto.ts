// AI 密钥加密工具
// 使用 AES-256-GCM 加密 AI 服务 API 密钥
// 加密密钥：优先使用独立的 AI_KEY_SECRET（start.js 自动生成）；
// 缺失时回退到 JWT_SECRET 派生（兼容旧部署）。
//
// B2 修正：注意——回退到 JWT_SECRET 意味着轮换 JWT_SECRET（且未设置
// AI_KEY_SECRET）会让所有已存密钥无法解密。因此生产部署必须设置独立的
// AI_KEY_SECRET；轮换密钥时优先轮换 AI_KEY_SECRET 并在轮换后让用户
// 重新录入各提供商密钥。密文带 "v1:" 版本前缀，便于未来引入多版本密钥。
// 加密格式: v1:base64(iv).base64(tag).base64(ciphertext)（v1 前缀可选，
// 旧格式无前缀的密文仍可解密，向后兼容）

import crypto from 'crypto'
import { getValidatedEnv } from './env.js'
import { logError } from './logger.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_VERSION = 'v1'

function getCryptoKey(): Buffer {
  const secret = process.env.AI_KEY_SECRET || getValidatedEnv().JWT_SECRET
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptApiKey(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, getCryptoKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${KEY_VERSION}:${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptApiKey(payload: string): string {
  try {
    // 兼容无版本前缀的旧格式密文
    const body = payload.startsWith(`${KEY_VERSION}:`) ? payload.slice(KEY_VERSION.length + 1) : payload
    const [ivB64, tagB64, dataB64] = body.split('.')
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('Invalid encrypted payload format')
    }
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getCryptoKey(),
      Buffer.from(ivB64, 'base64')
    )
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  } catch (error) {
    logError('Failed to decrypt API key', error)
    throw new Error('无法解密 AI 服务密钥')
  }
}
