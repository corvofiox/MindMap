/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  SECRET_KEYS,
  SECRETS_FILE_NAME,
  isPlaceholderSecret,
  resolveSecret,
  resolveSecrets,
  readSecretsFile,
  getSecretsFilePath,
  writeSecretsValue,
} from '../../../scripts/secret-persistence.js'

const JWT = 'JWT_SECRET'
const CSRF = 'CSRF_SECRET'
const AI = 'AI_KEY_SECRET'

let tmpDir: string
let envPath: string
let secretsPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-secrets-'))
  envPath = path.join(tmpDir, 'backend', '.env')
  secretsPath = path.join(tmpDir, 'backend', 'data', '.secrets')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeEnv(content: string) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, content)
}

function writeSecrets(content: string) {
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
  fs.writeFileSync(secretsPath, content)
}

describe('isPlaceholderSecret', () => {
  it('检测各类占位符形态', () => {
    expect(isPlaceholderSecret('')).toBe(true)
    expect(isPlaceholderSecret(undefined as any)).toBe(true)
    expect(isPlaceholderSecret('your-secret-key')).toBe(true)
    expect(isPlaceholderSecret('xxx-change-me-in-production-xxx')).toBe(true)
    expect(isPlaceholderSecret('your-csrf-secret-change-me-in-production')).toBe(true)
    expect(isPlaceholderSecret('dev-jwt-secret-key-for-development-only')).toBe(true)
    expect(isPlaceholderSecret('dev-csrf-secret-key-for-development-only')).toBe(true)
    expect(isPlaceholderSecret('real-secret-abc123')).toBe(false)
  })
})

describe('密钥持久化 resolveSecret / resolveSecrets', () => {
  it('场景1: 无 .env 无 .secrets → 生成随机,同时写入两者,权限 0600', () => {
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('generated')
    expect(r.value).toBeTruthy()
    expect(r.value).toHaveLength(128)
    // .env 与 .secrets 都写入同一值
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`JWT_SECRET=${r.value}`)
    expect(readSecretsFile(secretsPath)[JWT]).toBe(r.value)
    // 权限 0600
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600)
  })

  it('场景2: .secrets 有值 → 用之且不重新生成,并写回 .env', () => {
    writeSecrets(`${JWT}=persisted-secret-42\n${CSRF}=persisted-csrf-42\n${AI}=persisted-ai-42\n`)
    writeEnv(`${JWT}=your-secret-key-change-me-in-production\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('secrets')
    expect(r.value).toBe('persisted-secret-42')
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`${JWT}=persisted-secret-42`)
  })

  it('场景3: .env 有非占位符、.secrets 不存在 → 用 .env 值并迁移到 .secrets', () => {
    writeEnv(`${JWT}=from-env-secret\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('envfile')
    expect(r.value).toBe('from-env-secret')
    expect(readSecretsFile(secretsPath)[JWT]).toBe('from-env-secret')
    expect(fs.existsSync(secretsPath)).toBe(true)
  })

  it('场景4: process.env 注入 → 覆盖 .env,不污染 .secrets', () => {
    writeSecrets(`${JWT}=persisted-old\n`)
    writeEnv(`${JWT}=env-old\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: { JWT_SECRET: 'injected-new' } })
    expect(r.source).toBe('env')
    expect(r.value).toBe('injected-new')
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`${JWT}=injected-new`)
    expect(readSecretsFile(secretsPath)[JWT]).toBe('persisted-old')
  })

  it('场景5: .env 占位符值 → 视为无值重新生成', () => {
    writeEnv(`${JWT}=your-secret-key-change-me-in-production\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('generated')
    expect(r.value).toHaveLength(128)
    expect(r.value).not.toContain('change-me-in-production')
  })

  it('场景6: 幂等——连续两次解析值不变', () => {
    const first = resolveSecrets({ envPath, secretsPath, env: {} })
    const second = resolveSecrets({ envPath, secretsPath, env: {} })
    expect(second.map(x => x.value)).toEqual(first.map(x => x.value))
    expect(second.map(x => x.value)).not.toContain(undefined)
  })

  it('容器重建模拟: .env 被模板占位符覆盖,仅 .secrets 保留 → 恢复同一密钥不轮换', () => {
    const first = resolveSecrets({ envPath, secretsPath, env: {} })
    // 模拟容器重建: backend/.env 重新从模板复制(占位符),.secrets 在持久卷上保留
    writeEnv(`${JWT}=your-secret-key-change-me-in-production\n${CSRF}=your-csrf-secret-change-me-in-production\n`)
    const second = resolveSecrets({ envPath, secretsPath, env: {} })
    expect(second.map(x => x.value)).toEqual(first.map(x => x.value))
    expect(second.every(x => x.source === 'secrets')).toBe(true)
  })

  it('resolveSecrets 同时处理三个密钥,.secrets 仅含三键且 .env/.secrets 一致', () => {
    const results = resolveSecrets({ envPath, secretsPath, env: {} })
    expect(results.map(r => r.key)).toEqual(SECRET_KEYS)
    expect(results.every(r => r.source === 'generated')).toBe(true)
    const secrets = readSecretsFile(secretsPath)
    expect(Object.keys(secrets).sort()).toEqual([...SECRET_KEYS].sort())
    for (const r of results) {
      expect(fs.readFileSync(envPath, 'utf-8')).toContain(`${r.key}=${r.value}`)
      expect(secrets[r.key]).toBe(r.value)
    }
  })

  it('canGenerate=false 且无来源 → 不生成,返回 none(生产非 Docker 缺 AI_KEY_SECRET 场景)', () => {
    writeEnv(`${JWT}=valid-jwt\n${CSRF}=valid-csrf\n`)
    const r = resolveSecret(AI, { envPath, secretsPath, env: {}, canGenerate: false })
    expect(r.source).toBe('none')
    expect(r.value).toBeUndefined()
    expect(fs.existsSync(secretsPath)).toBe(false)
  })

  it('.secrets 中的占位符值 → 视为无值重新生成', () => {
    writeSecrets(`${JWT}=your-secret-key-change-me-in-production\n`)
    writeEnv(`${JWT}=your-secret-key-change-me-in-production\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('generated')
    expect(readSecretsFile(secretsPath)[JWT]).toBe(r.value)
  })

  it('.secrets 中未知键被忽略,重写后仅保留已解析的已知键', () => {
    writeSecrets(`FOO=bar\n${JWT}=persisted-42\n`)
    resolveSecret(CSRF, { envPath, secretsPath, env: {} })
    const secrets = readSecretsFile(secretsPath)
    // FOO 被过滤,仅含已解析的已知键(CSRF 新写入 + JWT 原有保留)
    expect(Object.keys(secrets).sort()).toEqual([CSRF, JWT].sort())
    expect(secrets[JWT]).toBe('persisted-42')
    expect((secrets as any).FOO).toBeUndefined()
  })

  it('可注入确定性 generate 生成器', () => {
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {}, generate: () => 'fixed-secret-value' })
    expect(r.source).toBe('generated')
    expect(r.value).toBe('fixed-secret-value')
    expect(readSecretsFile(secretsPath)[JWT]).toBe('fixed-secret-value')
  })

  it('env 注入空字符串视为未注入(与旧实现 falsy 判断一致)', () => {
    writeEnv(`${JWT}=existing\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: { JWT_SECRET: '' } })
    expect(r.source).toBe('envfile')
    expect(r.value).toBe('existing')
  })

  it('getSecretsFilePath 返回 backend/data/.secrets', () => {
    expect(getSecretsFilePath('/app/backend')).toBe(path.join('/app/backend', 'data', SECRETS_FILE_NAME))
  })

  it('.env 缺失时(仅 .secrets 有值)也能恢复并创建 .env', () => {
    writeSecrets(`${JWT}=recovered-secret\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('secrets')
    expect(r.value).toBe('recovered-secret')
    expect(fs.existsSync(envPath)).toBe(true)
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`${JWT}=recovered-secret`)
  })

  it('AI_KEY_SECRET 缺失且 canGenerate=true(容器/开发) → 生成并持久化', () => {
    writeEnv(`${JWT}=valid-jwt\n${CSRF}=valid-csrf\n`)
    const r = resolveSecret(AI, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('generated')
    expect(readSecretsFile(secretsPath)[AI]).toBe(r.value)
  })

  it('M1冲突: .secrets 与 .env 值不同 → .secrets 权威,返回 conflictWithEnvFile=true 且覆盖 .env', () => {
    writeSecrets(`${JWT}=persisted-value-a\n`)
    writeEnv(`${JWT}=manually-rotated-b\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('secrets')
    expect(r.value).toBe('persisted-value-a')
    expect(r.conflictWithEnvFile).toBe(true)
    // .env 被覆盖回 .secrets 的值(调用方应 WARN 提示)
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`${JWT}=persisted-value-a`)
  })

  it('M1无冲突: .secrets 与 .env 同值 → conflictWithEnvFile=false', () => {
    writeSecrets(`${JWT}=same-value\n`)
    writeEnv(`${JWT}=same-value\n`)
    const r = resolveSecret(JWT, { envPath, secretsPath, env: {} })
    expect(r.source).toBe('secrets')
    expect(r.conflictWithEnvFile).toBe(false)
  })

  it('m3: 已存在 0644 的 .secrets 重写后权限为 0600,且无 .tmp 残留(原子写)', () => {
    writeSecrets(`${JWT}=old\n`)
    fs.chmodSync(secretsPath, 0o644)
    writeSecretsValue(secretsPath, JWT, 'new-value')
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(secretsPath, 'utf-8')).toContain(`${JWT}=new-value`)
    expect(fs.existsSync(`${secretsPath}.tmp`)).toBe(false)
  })

  it('m6-截断恢复: .secrets 缺键时从 .env 迁移/生成恢复,不影响已有键', () => {
    // .secrets 只含 JWT(模拟崩溃截断后仅剩一行),CSRF/AI 缺失
    writeSecrets(`${JWT}=survived-jwt\n`)
    writeEnv(`${JWT}=your-secret-key-change-me-in-production\n${CSRF}=valid-csrf-value\n`)
    const results = resolveSecrets({ envPath, secretsPath, env: {} })
    const byKey = Object.fromEntries(results.map(r => [r.key, r]))
    expect(byKey[JWT].source).toBe('secrets')
    expect(byKey[JWT].value).toBe('survived-jwt')
    // CSRF 从 .env 恢复并迁移(③ envfile),AI 生成(④ generated)
    expect(byKey[CSRF].source).toBe('envfile')
    expect(byKey[CSRF].value).toBe('valid-csrf-value')
    expect(byKey[AI].source).toBe('generated')
    // 重写后三键都在 .secrets 且 JWT 值不变
    const secrets = readSecretsFile(secretsPath)
    expect(secrets[JWT]).toBe('survived-jwt')
    expect(secrets[CSRF]).toBe('valid-csrf-value')
    expect(secrets[AI]).toBe(byKey[AI].value)
  })
})
