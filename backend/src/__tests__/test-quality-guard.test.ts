/**
 * 源码守卫：测试必须真实有效。
 *
 * 背景（2026-10-13 全量审视；2026-10-14 加固）：本项目曾存在大量"假测试"，它们
 * 看起来在覆盖功能、实际什么都没验证。已确认并钉死的形态：
 *
 *   1. **自造实现**：测试文件不 import 任何项目代码，而是在文件里重新写一遍
 *      被测逻辑（如本地 `validateEmail`、本地 `getErrorMessageByStatus`、
 *      本地 `MergeTestHelper`），然后断言自己那份副本。
 *      —— 生产代码怎么改，测试都不会失败。
 *   2. **不 await 的 supertest**：`const res = request(app).get(...)` 拿到的是
 *      supertest 的 Test 对象而非响应；随后 `expect(res).toBeDefined()` 恒真。
 *   3. **只断言 toBeDefined/toBeTruthy**：对同一个表达式没有任何实质性断言。
 *
 * 2026-10-14 审计实测出三个绕过，本次一并钉死：
 *
 *   4. **request.agent 链不 await**：`request.agent(app).get(...)` 与
 *      `request(app).get(...)` 同罪 —— 旧正则只认 `request(`/`supertest(` 开头，
 *      中间多了 `.agent` 就漏网。注意 `request.agent(app)`（仅创建 agent、不发
 *      请求）是合法的，检测必须锚定后面的 HTTP 动词，否则误伤 agent 创建。
 *   5. **预声明后重新赋值**：`let res` 之后再 `res = request(app).get(...)`
 *      （无 await）—— 旧检查只看声明处的赋值。
 *   6. **整块零断言**：it/test 块内一个 expect 匹配器都没有 —— 根本没在验证
 *      任何东西，却计入"已覆盖"。
 *
 * 同步把弱断言/零断言/跳过检查扩展到 frontend 测试（此前只遍历 backend），
 * 并适配 testing-library 语义：getBy*、queryBy*、findBy*、getAllBy*、screen.* 的
 * 查询在元素缺席时直接抛错，本身就是真实断言 —— 不得因此标记。
 *
 * 后果实证：把 `canvas.controller.ts` 的列表路由改成永远返回 500，
 * 对应的 25 条"测试"依然全绿；三个 controller 因此长期停在 0% 覆盖率。
 *
 * 每个检测点都有内嵌探针（GUARD PROBES 区）自证：既抓得住反模式、也放得过
 * 合法写法。探针区在仓库扫描前被剥离，不会反过来命中守卫自身。
 * 本守卫只做**可客观判定**的检查，不试图猜测语义 —— 需要人判断的部分留给 review。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// This file lives in backend/src/__tests__/, so:
//   backendSrc   = backend/src            (the tree that holds backend sources + tests)
//   backendPkg   = backend                (package root)
//   repoRoot     = the monorepo root
const backendSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendPkg = path.resolve(backendSrc, '..')
const repoRoot = path.resolve(backendPkg, '..')

/** 收集某个根目录下的所有测试文件（排除 node_modules / dist / coverage）。 */
function collectTestFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectTestFiles(full, acc)
    else if (/\.test\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

/** 相对路径，用于报错信息。 */
function rel(p: string): string {
  return path.relative(repoRoot, p).replace(/\\/g, '/')
}

/**
 * 判断一个 import 说明符是否指向"项目自己的代码"。
 * 相对路径与 `@/` 别名都算；裸模块名（vitest/node/express…）不算。
 */
function isProjectImport(specifier: string): boolean {
  if (specifier.startsWith('.')) return true
  if (specifier.startsWith('@/')) return true
  return false
}

/** 取出文件中所有 import 的说明符（静态 import 与动态 `await import(...)` 都算）。 */
function importSpecifiers(src: string): string[] {
  const statics = [...src.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  )
  const dynamics = [...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  return [...statics, ...dynamics]
}

const backendTests = collectTestFiles(backendSrc)
const frontendTests = collectTestFiles(path.join(repoRoot, 'frontend', 'src'))

// ═══════════════════════ GUARD PROBES BEGIN ═══════════════════════
// 以下字符串是喂给检测函数的反模式样本与合法对照样本，不是可执行测试。
// 它们必须与仓库扫描隔离（stripGuardProbes），否则守卫会抓到自己。

const PROBE_SUPERTEST_AGENT_UNAWAITED = `
it('探针：request.agent 链声明赋值未 await', async () => {
  const res = request.agent(app).get('/api/projects')
  expect(res).toBeDefined()
})
`

const PROBE_SUPERTEST_AGENT_DISCARDED = `
it('探针：request.agent 链结果被丢弃', () => {
  request.agent(app).get('/api/projects')
})
`

const PROBE_SUPERTEST_AGENT_AWAITED = `
it('对照：request.agent 链已 await', async () => {
  const res = await request.agent(app).get('/api/projects')
  expect(res.status).toBe(200)
})
`

const PROBE_SUPERTEST_AGENT_HANDLE_ONLY = `
it('对照：单独创建 agent 不发请求', () => {
  const agent = request.agent(app)
  expect(agent).toBeDefined()
})
`

const PROBE_SUPERTEST_REASSIGNED_UNAWAITED = `
it('探针：预声明后重新赋值未 await', async () => {
  let res
  res = request(app).get('/api/projects')
  expect(res).toBeDefined()
})
`

const PROBE_SUPERTEST_REASSIGNED_AWAITED = `
it('对照：重新赋值但已 await', async () => {
  let res
  res = await request(app).get('/api/projects')
  expect(res.status).toBe(200)
})
`

const PROBE_BLOCK_WITHOUT_EXPECT = `
it('探针：整块零断言', async () => {
  const res = await request(app).get('/api/health')
  console.log(res.status)
})
`

const PROBE_BLOCK_WITH_EXPECT = `
it('对照：块内有 expect 断言', async () => {
  const res = await request(app).get('/api/health')
  expect(res.status).toBe(200)
})
`

const PROBE_FRONTEND_NO_EXPECT_NO_QUERY = `
it('探针：前端块既无断言调用也无查询', () => {
  const { container } = render(<Panel />)
  console.log(container.innerHTML)
})
`

const PROBE_FRONTEND_QUERY_ONLY = `
it('对照：getByText 查询缺席即抛错，是真实断言', async () => {
  render(<Panel />)
  await waitFor(() => expect(screen.getByText('标题')).toBeTruthy())
  expect(screen.getByText('内容')).toBeTruthy()
})
`

const PROBE_FRONTEND_WEAK_WITHOUT_QUERY = `
it('探针：前端块只有恒真匹配器且无查询', () => {
  const utils = render(<Panel />)
  expect(utils.container).toBeTruthy()
})
`

const PROBE_FRONTEND_WEAK_WITH_QUERY = `
it('对照：弱匹配器但有 getBy 查询兜底（AccessTokensPanel 形态）', () => {
  render(<Panel />)
  expect(screen.getByText('标题')).toBeTruthy()
})
`

const PROBE_SKIPPED = `
describe.skip('探针：describe.skip', () => {})
it.skip('探针：it.skip', () => {})
it.todo('探针：it.todo')
xit('探针：xit', () => {})
xdescribe('探针：xdescribe', () => {})
`

const PROBE_NOT_SKIPPED = `
describe('对照：正常 describe', () => {
  it('对照：正常 it', () => {
    expect(1).toBe(1)
  })
})
`

// ═══════════════════════ GUARD PROBES END ═══════════════════════

/**
 * 剥离探针区（从 GUARD PROBES BEGIN 行到 GUARD PROBES END 行，含两端）。
 * 探针是故意写坏的反模式样本；仓库扫描前必须剥掉，否则守卫会抓到自己。
 */
function stripGuardProbes(src: string): string {
  const lines = src.split('\n')
  const beginIdx = lines.findIndex((l) => l.includes('GUARD PROBES BEGIN'))
  const endIdx = lines.findIndex((l) => l.includes('GUARD PROBES END'))
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return src
  return [...lines.slice(0, beginIdx), ...lines.slice(endIdx + 1)].join('\n')
}

/** 读取测试文件并剥离探针区（探针只存在于守卫自身文件中，其余文件原样返回）。 */
function readTestSource(file: string): string {
  return stripGuardProbes(fs.readFileSync(file, 'utf8'))
}

interface TestBlock {
  title: string
  body: string
}

/** 按行首 it(/test( 把源码切成测试块（与旧实现同一策略，含其已知局限）。 */
function findTestBlocks(src: string): TestBlock[] {
  const re = /^[ \t]*(?:it|test)(?:\.\w+)?\s*\(/gm
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) starts.push(m.index)
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : src.length
    const body = src.slice(start, end)
    const title = body.match(/^\s*(?:it|test)(?:\.\w+)?\s*\(\s*['"`]([^'"`]*)/)
    return { title: title ? title[1] : '(unknown)', body }
  })
}

/**
 * 块内所有 vitest 匹配器名（toXxx）。
 * 按匹配器名而非 expect(...) 参数判断：对参数做正则会在嵌套括号上翻车，
 * 例如 `expect(decodeURIComponent(v)).toBe(t)` 会被误读成没有实质断言。
 */
function matchersOf(block: string): string[] {
  return [...block.matchAll(/\.\s*(?:not\s*\.\s*)?(to[A-Z]\w*)\s*\(/g)].map((mm) => mm[1])
}

/** testing-library 查询（getBy*、queryBy*、findBy*、getAllBy*、screen.*）：元素缺席即抛错，本身就是真实断言。 */
function hasTestingLibraryQuery(body: string): boolean {
  return /\b(?:get|query|find)(?:All)?By[A-Z]/.test(body) || /\bscreen\s*\./.test(body)
}

const WEAK_MATCHERS = new Set(['toBeDefined', 'toBeTruthy'])

/**
 * 未等待的 supertest 调用（含 request.agent 链与预声明后再赋值两种绕过）。
 *
 * supertest 只有在真正发出 HTTP 动词后才产生 Test 对象（thenable）；
 * `request.agent(app)`（创建 agent）与 `request(app)`（取句柄）本身合法，
 * agent 链的检测必须锚定动词链，否则会误伤合法的 agent/handle 创建。
 */
function findUnawaitedSupertest(src: string, file: string): string[] {
  const offenders: string[] = []
  const lines = src.split('\n')

  const VERB = String.raw`(?:get|post|put|patch|delete|del|head)`
  // (request|supertest)[.agent](args).verb( —— 同时覆盖 request(app).get(...) 与 request.agent(app).get(...)
  const VERB_CHAIN = String.raw`(?:request|supertest)(?:\s*\.\s*agent)?\s*\([^()]*\)\s*\.\s*${VERB}\s*\(`

  // 形态一（旧）：声明处赋值 —— 保留旧语义（即使没有动词也检，向后兼容）
  const declAny = /(?:const|let|var)\s+\w+\s*=\s*(?:request|supertest)\s*\(/
  // 形态一（新）：声明处直接接动词链 —— request.agent 形态只有这条路能被检出
  const declVerbChain = new RegExp(String.raw`(?:const|let|var)\s+\w+\s*=\s*` + VERB_CHAIN)
  // 形态二（新）：预声明后重新赋值 `res = request(app).get(...)` —— 必须接动词链
  const reassignVerbChain = new RegExp(String.raw`^[\w$.]+\s*=(?![=>]).*` + VERB_CHAIN)
  // 形态三：语句级调用、结果被丢弃（旧 statement 保留 + 新 agent 链形态）
  const stmtVerbChain = new RegExp(
    String.raw`^(?:request|supertest)(?:\s*\.\s*agent)?\s*\([^()]*\)\s*\.\s*` + VERB + String.raw`\s*\(`,
  )

  lines.forEach((line, i) => {
    // 注释行里提到 request(app) 不是调用
    const trimmedLine = line.trim()
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*')) return

    const isAssignment = declAny.test(line) || declVerbChain.test(line)
    const isReassignment = reassignVerbChain.test(trimmedLine)
    const statementMatch =
      trimmedLine.match(/^(?:request|supertest)\s*\(/) !== null || stmtVerbChain.test(trimmedLine)
    if (!isAssignment && !isReassignment && !statementMatch) return
    if (/\b(await|return)\b/.test(trimmedLine)) return

    if (statementMatch && !isReassignment) {
      // 丢弃结果形态：结果实际被消费的豁免
      const prevLine = (() => {
        for (let j = i - 1; j >= 0; j--) {
          const t = lines[j].trim()
          if (t) return t
        }
        return ''
      })()
      const isArrowBodyReturn = prevLine.endsWith('=>')
      const isListElement = trimmedLine.endsWith(',')
      if (isArrowBodyReturn || isListElement) return
    }

    // 允许后续 3 行内 .then( 链接
    const rest = lines.slice(i, i + 3).join(' ')
    if (/\.then\s*\(/.test(rest)) return
    offenders.push(`${file}:${i + 1}  ${line.trim()}`)
  })
  return offenders
}

/**
 * 整块零断言：it/test 块内一个 expect 匹配器都没有。
 * backend 适用（backend 没有 testing-library 语义）。
 */
function findAssertionlessBlocks(src: string, file: string): string[] {
  const offenders: string[] = []
  for (const { title, body } of findTestBlocks(src)) {
    if (matchersOf(body).length === 0) offenders.push(`${file} :: ${title}`)
  }
  return offenders
}

/**
 * frontend 零断言：块内既无 expect 也无 testing-library 查询。
 * getBy*、screen.* 查询缺席即抛错，算真实断言 —— 不得标记。
 */
function findFrontendAssertionlessBlocks(src: string, file: string): string[] {
  const offenders: string[] = []
  for (const { title, body } of findTestBlocks(src)) {
    const hasExpect = /\bexpect[\s.(]/.test(body)
    const hasQuery = hasTestingLibraryQuery(body)
    if (!hasExpect && !hasQuery) offenders.push(`${file} :: ${title}`)
  }
  return offenders
}

/**
 * 只断言 toBeDefined/toBeTruthy（恒真）。
 * exemptQuery=true（frontend）：块内存在 testing-library 查询时豁免 ——
 * 查询缺席即抛错已经构成真实断言，弱匹配器只是锦上添花。
 */
function findOnlyTruthyBlocks(
  src: string,
  file: string,
  opts: { exemptQuery: boolean },
): string[] {
  const offenders: string[] = []
  for (const { title, body } of findTestBlocks(src)) {
    const matchers = matchersOf(body)
    if (matchers.length === 0) continue // 零断言由"块必须有断言"检查负责
    const negated = /\.\s*not\s*\./.test(body)
    const onlyWeak = !negated && matchers.every((name) => WEAK_MATCHERS.has(name))
    if (!onlyWeak) continue
    if (opts.exemptQuery && hasTestingLibraryQuery(body)) continue
    offenders.push(`${file} :: ${title}`)
  }
  return offenders
}

/** 被跳过的测试：it/test/describe 的 .skip / .todo，以及 xit / xdescribe / xtest 前缀。 */
function findSkippedTests(src: string, file: string): string[] {
  const offenders: string[] = []
  src.split('\n').forEach((line, i) => {
    if (/^\s*(?:it|test|describe)\.(?:skip|todo)\b/.test(line)) {
      offenders.push(`${file}:${i + 1}  ${line.trim()}`)
      return
    }
    if (/^\s*x(?:it|describe|test)\b/.test(line)) {
      offenders.push(`${file}:${i + 1}  ${line.trim()}`)
    }
  })
  return offenders
}

/**
 * Self-check: if the collector ever finds nothing (a wrong root, a changed layout),
 * every assertion below would pass vacuously and the guard would silently stop
 * protecting anything. Fail loudly instead.
 */
describe('源码守卫自检', () => {
  it('确实扫到了测试文件（否则所有守卫都是空转）', () => {
    expect(backendTests.length).toBeGreaterThan(10)
    expect(frontendTests.length).toBeGreaterThan(10)
    // 守卫自身也必须被扫到
    expect(backendTests.some((f) => f.endsWith('test-quality-guard.test.ts'))).toBe(true)
  })
})

/**
 * Files that legitimately import no project module.
 *
 * Source-guard tests assert a property of the repository (they read files with
 * `fs`) rather than the behaviour of a module, so requiring a project import of
 * them would be wrong. Kept as an explicit, reviewable list rather than a name
 * pattern so it cannot be widened by accident — and so adding an entry is a
 * visible change in review.
 */
const NO_PROJECT_IMPORT_ALLOWED = new Set(['backend/src/__tests__/test-quality-guard.test.ts'])

describe('源码守卫：测试必须真实有效', () => {
  describe('测试文件必须 import 项目代码', () => {
    it('backend 测试文件都引用了项目模块（不是自造实现）', () => {
      const offenders: string[] = []
      for (const file of backendTests) {
        // helpers 目录下是共享夹具，不是测试用例
        if (file.includes(`${path.sep}helpers${path.sep}`)) continue
        if (NO_PROJECT_IMPORT_ALLOWED.has(rel(file))) continue
        const src = readTestSource(file)
        const projectImports = importSpecifiers(src).filter(isProjectImport)
        if (projectImports.length === 0) offenders.push(rel(file))
      }
      expect(
        offenders,
        `以下 backend 测试文件没有 import 任何项目代码，无法验证真实行为：\n${offenders.join('\n')}`,
      ).toEqual([])
    })

    it('frontend 测试文件都引用了项目模块（不是自造实现）', () => {
      const offenders: string[] = []
      for (const file of frontendTests) {
        const src = readTestSource(file)
        const projectImports = importSpecifiers(src).filter(isProjectImport)
        if (projectImports.length === 0) offenders.push(rel(file))
      }
      expect(
        offenders,
        `以下 frontend 测试文件没有 import 任何项目代码，无法验证真实行为：\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('supertest 调用必须被 await / return', () => {
    it('backend 测试里不存在未等待的 supertest 调用（含 request.agent 链与预声明后再赋值）', () => {
      const offenders = backendTests.flatMap((file) =>
        findUnawaitedSupertest(readTestSource(file), rel(file)),
      )
      expect(
        offenders,
        `以下 supertest 调用没有被 await/return —— 断言的是 Test 对象而非响应：\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('每个 it/test 块必须有断言（backend）', () => {
    it('backend 没有 0 断言的 it/test 块', () => {
      const offenders = backendTests.flatMap((file) =>
        findAssertionlessBlocks(readTestSource(file), rel(file)),
      )
      expect(
        offenders,
        `以下测试块内一个 expect 都没有，什么都没验证：\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('不得只断言 toBeDefined/toBeTruthy', () => {
    it('backend 每个 it/test 至少有一条实质性断言', () => {
      const offenders = backendTests.flatMap((file) =>
        findOnlyTruthyBlocks(readTestSource(file), rel(file), { exemptQuery: false }),
      )
      expect(
        offenders,
        `以下测试只断言 toBeDefined/toBeTruthy，恒真：\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('frontend：零断言与弱断言检查（testing-library 语义适配）', () => {
    it('frontend 没有"既无 expect 也无 getBy*/screen.* 查询"的 it/test 块', () => {
      const offenders = frontendTests.flatMap((file) =>
        findFrontendAssertionlessBlocks(readTestSource(file), rel(file)),
      )
      expect(
        offenders,
        `以下 frontend 测试块内没有任何 expect 也没有任何查询调用，什么都没验证：\n${offenders.join('\n')}`,
      ).toEqual([])
    })

    it('frontend 没有"只断言 toBeDefined/toBeTruthy 且无查询兜底"的 it/test 块', () => {
      const offenders = frontendTests.flatMap((file) =>
        findOnlyTruthyBlocks(readTestSource(file), rel(file), { exemptQuery: true }),
      )
      expect(
        offenders,
        `以下 frontend 测试块只剩恒真匹配器（且无 getBy 类查询兜底，查询缺席即抛错才算真实断言）：\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('不得跳过测试', () => {
    it('backend 没有 it.skip / it.todo / describe.skip / xit / xdescribe 残留', () => {
      const offenders = backendTests.flatMap((file) =>
        findSkippedTests(readTestSource(file), rel(file)),
      )
      expect(offenders, `存在被跳过的测试：\n${offenders.join('\n')}`).toEqual([])
    })

    it('frontend 没有 it.skip / it.todo / describe.skip / xit / xdescribe 残留', () => {
      const offenders = frontendTests.flatMap((file) =>
        findSkippedTests(readTestSource(file), rel(file)),
      )
      expect(offenders, `存在被跳过的测试：\n${offenders.join('\n')}`).toEqual([])
    })
  })
})

// ═══════════════════════ 探针自证 ═══════════════════════
// 每个检测点必须证明：抓得住反模式（阳性）、放得过合法写法（阴性）。
// 探针字符串在上方 GUARD PROBES 区定义，仓库扫描前已被剥离。

describe('守卫探针自证：抓得住反模式、放得过合法写法', () => {
  describe('检测点：supertest 必须 await（request.agent 链 / 预声明后再赋值）', () => {
    it('抓住：request.agent(app).get(...) 声明赋值未 await', () => {
      const hits = findUnawaitedSupertest(PROBE_SUPERTEST_AGENT_UNAWAITED, 'probe.ts')
      expect(hits).toHaveLength(1)
      expect(hits[0]).toContain('request.agent')
    })

    it('抓住：request.agent(app).get(...) 结果被丢弃', () => {
      expect(findUnawaitedSupertest(PROBE_SUPERTEST_AGENT_DISCARDED, 'probe.ts')).toHaveLength(1)
    })

    it('抓住：预声明后重新赋值 res = request(app).get(...) 未 await', () => {
      const hits = findUnawaitedSupertest(PROBE_SUPERTEST_REASSIGNED_UNAWAITED, 'probe.ts')
      expect(hits).toHaveLength(1)
    })

    it('放过：await request.agent(app).get(...)', () => {
      expect(findUnawaitedSupertest(PROBE_SUPERTEST_AGENT_AWAITED, 'probe.ts')).toEqual([])
    })

    it('放过：单独创建 agent（request.agent(app)，没有动词链）', () => {
      expect(findUnawaitedSupertest(PROBE_SUPERTEST_AGENT_HANDLE_ONLY, 'probe.ts')).toEqual([])
    })

    it('放过：重新赋值但已 await', () => {
      expect(findUnawaitedSupertest(PROBE_SUPERTEST_REASSIGNED_AWAITED, 'probe.ts')).toEqual([])
    })
  })

  describe('检测点：it/test 块必须有断言（backend）', () => {
    it('抓住：块内 0 个 expect 匹配器', () => {
      const hits = findAssertionlessBlocks(PROBE_BLOCK_WITHOUT_EXPECT, 'probe.ts')
      expect(hits).toHaveLength(1)
      expect(hits[0]).toContain('探针：整块零断言')
    })

    it('放过：块内有 expect', () => {
      expect(findAssertionlessBlocks(PROBE_BLOCK_WITH_EXPECT, 'probe.ts')).toEqual([])
    })
  })

  describe('检测点：frontend 块既无 expect 也无 testing-library 查询', () => {
    it('抓住：无 expect 无查询', () => {
      const hits = findFrontendAssertionlessBlocks(PROBE_FRONTEND_NO_EXPECT_NO_QUERY, 'probe.tsx')
      expect(hits).toHaveLength(1)
    })

    it('放过：getByText 查询（缺席即抛错，真实断言）', () => {
      expect(findFrontendAssertionlessBlocks(PROBE_FRONTEND_QUERY_ONLY, 'probe.tsx')).toEqual([])
    })
  })

  describe('检测点：frontend 只剩恒真匹配器且无查询', () => {
    it('抓住：只有 toBeTruthy 且无查询', () => {
      const hits = findOnlyTruthyBlocks(PROBE_FRONTEND_WEAK_WITHOUT_QUERY, 'probe.tsx', {
        exemptQuery: true,
      })
      expect(hits).toHaveLength(1)
    })

    it('放过：弱匹配器但有 getBy 查询兜底（AccessTokensPanel 形态）', () => {
      expect(
        findOnlyTruthyBlocks(PROBE_FRONTEND_WEAK_WITH_QUERY, 'probe.tsx', { exemptQuery: true }),
      ).toEqual([])
    })

    it('backend 语境不做查询豁免：同一形态在 backend 仍然违规', () => {
      expect(
        findOnlyTruthyBlocks(PROBE_FRONTEND_WEAK_WITH_QUERY, 'probe.ts', { exemptQuery: false }),
      ).toHaveLength(1)
    })
  })

  describe('检测点：不得跳过测试（skip/todo/x 前缀）', () => {
    it('抓住：it.skip / describe.skip / it.todo / xit / xdescribe', () => {
      const hits = findSkippedTests(PROBE_SKIPPED, 'probe.ts')
      expect(hits).toHaveLength(5)
    })

    it('放过：正常 describe/it', () => {
      expect(findSkippedTests(PROBE_NOT_SKIPPED, 'probe.ts')).toEqual([])
    })
  })
})
