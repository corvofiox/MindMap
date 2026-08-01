// AI 密钥加密工具
// 使用 AES-256-GCM 加密 AI 服务 API 密钥
// 加密密钥：优先使用独立的 AI_KEY_SECRET（start.js 自动生成），
// 缺失时回退到 JWT_SECRET 派生（兼容旧部署），避免 JWT 轮换导致已存密钥全部失效
// 加密格式: base64(iv).base64(tag).base64(ciphertext)

import crypto from 'crypto'
import { getValidatedEnv } from './env.js'
import { logError } from './logger.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

function getCryptoKey(): Buffer {
  const secret = process.env.AI_KEY_SECRET || getValidatedEnv().JWT_SECRET
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptApiKey(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, getCryptoKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptApiKey(payload: string): string {
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.')
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
