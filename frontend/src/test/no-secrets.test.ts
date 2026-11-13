/**
 * 公开仓库的防泄漏门禁。
 *
 * 为什么需要它：本项目是公开仓库，而仓库里有一些"看起来无害、实际会泄露"
 * 的东西——
 *   - 测试里写死真实账号密码（曾经发生过：登录页测试用的是正在运行的演示
 *     实例的真实邮箱与密码，等于直接公开）；
 *   - env 文件里把占位符换成真实密钥（.env.development 是故意入库的）；
 *   - 有人把 data/ 下的数据库、uploads 里的文件、日志误提交。
 *
 * 这些都不会让测试变红、也不会让构建失败，只能靠专门的门禁拦。
 * 这里只做"能被自动判定"的部分；真正的密钥轮换策略另说。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 被追踪的文件清单（从 git 读，避免遍历 node_modules 与 dist） */
function trackedFiles(): string[] {
  const out = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' })
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

function readTracked(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

/** 源码类文件：只在这些里面找硬编码凭据 */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

describe('公开仓库不含真实凭据', () => {
  it('源码里没有真实格式的云厂商 / 平台密钥', () => {
    // 这些前缀都有固定形态，误报率极低
    const patterns: Array<{ name: string; re: RegExp }> = [
      { name: 'OpenAI/DeepSeek key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
      { name: 'GitHub PAT (classic)', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
      { name: 'GitHub PAT (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
      { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
      { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
      { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
      { name: 'JWT（长串，疑似真实令牌）', re: /\beyJhbGciOi[A-Za-z0-9_-]{40,}\b/ },
    ]

    const offenders: string[] = []
    for (const file of trackedFiles()) {
      if (!SOURCE_EXT.test(file)) continue
      const content = readTracked(file)
      for (const { name, re } of patterns) {
        if (re.test(content)) offenders.push(`${file} :: ${name}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('入库的 env 文件里只有占位符，没有真实密钥', () => {
    // 按 .gitignore 的约定，只有这些带 .example / .development 的允许入库
    const envFiles = trackedFiles().filter(
      (f) => /(^|\/)\.env/.test(f) && !/\.(example|development)$/.test(f),
    )
    // 除白名单外不应有别的 env 文件被跟踪
    expect(envFiles).toEqual([])

    const allowed = trackedFiles().filter((f) => /(^|\/)\.env\.(example|development)$/.test(f))
    expect(allowed.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of allowed) {
      for (const line of readTracked(file).split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i)
        if (!match) continue
        const [, key, value] = match
        // 占位符的特征：含 change-me / your- / dev- / example / not-real，或全是 x/*
        const isPlaceholder =
          /change[-_]?me|your[-_]|^dev-|for-development-only|example|placeholder|not-real|^x+$/i.test(value) ||
          /^<.*>$/.test(value) ||
          value.length === 0
        if (!isPlaceholder) {
          offenders.push(`${file} :: ${key}=${value}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('没有把数据库 / 日志 / 上传目录 / 临时产物提交上去', () => {
    const forbidden = trackedFiles().filter((file) => {
      if (/(^|\/)node_modules\//.test(file)) return true
      if (/(^|\/)dist\//.test(file)) return true
      if (/^data\//.test(file) || /(^|\/)data\/.*\.(db|sqlite3?)$/.test(file)) return true
      if (/^logs\//.test(file) || /\.log$/.test(file)) return true
      if (/^uploads\//.test(file)) return true
      if (/^\.e2e\//.test(file)) return true
      if (/\.(db|db-wal|db-shm|sqlite|sqlite3)$/.test(file)) return true
      if (/\.(pem|key|p12|pfx)$/.test(file)) return true
      return false
    })

    expect(forbidden).toEqual([])
  })

  it('测试代码里不出现「真实域名邮箱 + 强密码」的组合', () => {
    // 曾经的坑：登录页测试直接用了演示实例的真实邮箱 + 密码。
    //
    // 刻意**不**拦"测试里的假密码"（longenough8 / pw123456 / password123 这类
    // 一眼假的串）：那些没有任何泄露风险，拦它们只会制造噪音，最后被人
    // 加一堆例外规则，门禁就形同虚设。
    // 真正会出事的是"真实服务能用的账号"——即公网域名邮箱配上强密码。
    const offenders: string[] = []
    const realDomainEmail = /['"`][A-Za-z0-9._%+-]+@(?!example\.|test\.|mindmap\.local|localhost)[A-Za-z0-9.-]+\.[A-Za-z]{2,}['"`]/g
    const strongPassword = /['"][^'"\s]{8,}!['"]/

    for (const file of trackedFiles()) {
      if (!SOURCE_EXT.test(file)) continue
      if (!/__tests__\/|\.test\.(ts|tsx|js|jsx)$|^e2e\//.test(file)) continue
      const content = readTracked(file)
      const emails = [...content.matchAll(realDomainEmail)].map((m) => m[0])
      if (emails.length === 0) continue
      const pw = content.match(strongPassword)
      if (pw) offenders.push(`${file} :: ${emails[0]} + ${pw[0]}`)
    }

    expect(offenders).toEqual([])
  })

  it('仓库里没有把演示实例的真实账号密码写死', () => {
    // 这一条是"上次真的漏了"的回归：演示账号密码曾被写进前端登录页测试。
    //
    // 判定要点：e2e 脚本会合法地用到 @mindmap.local —— 但那是运行时拼出来的
    // 一次性账号（`e2e+<时间戳>@mindmap.local`），每次跑注册一个新号，不是真实账号。
    // 真正要拦的是「固定的邮箱字面量 + 强密码字面量」同时出现。
    const offenders: string[] = []
    for (const file of trackedFiles()) {
      if (!SOURCE_EXT.test(file)) continue
      const content = readTracked(file)

      // 固定写死的邮箱：引号里直接是 xxx@mindmap.local，不含模板变量
      const hardcodedEmail = /['"`][A-Za-z0-9._%+-]+@mindmap\.local['"`]/.test(content)
      if (!hardcodedEmail) continue

      // 再要求同文件里有强密码字面量（8 位以上、带大小写数字或符号）
      const strongPassword = content.match(/['"][^'"\s]{8,}!['"]/) ||
        content.match(/['"](?=.*[A-Z])(?=.*[a-z])(?=.*\d)[^'"\s]{10,}['"]/)
      if (strongPassword) offenders.push(`${file} :: ${strongPassword[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('.gitignore 仍然挡住运行时数据与依赖', () => {
    const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8')
    for (const rule of ['node_modules/', 'dist/', 'data/', 'logs/', 'uploads/', '*.log', '.env']) {
      expect(gitignore).toContain(rule)
    }
    // 本地存在但不能被跟踪的目录，随便挑一个验证真的被忽略
    if (existsSync(resolve(repoRoot, '.e2e'))) {
      const out = execSync('git check-ignore -q .e2e && echo ignored || echo tracked', {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()
      expect(out).toBe('ignored')
    }
  })
})
