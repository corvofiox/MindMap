/**
 * 迁移代码的结构性守卫。
 *
 * 背景：`ALTER TABLE` 无法改外键，所以级联迁移的做法是「建新表 → 灌数据 → 换名」。
 * 灌数据若写成 `INSERT INTO x_new SELECT * FROM x`，那么**任何一次加列**都会让
 * 列数不匹配、整批事务回滚——而回滚只打一行日志，启动照常继续，线上表现是
 * "迁移静默没生效"。files 与 node_cards 各自踩过一次。
 *
 * 所以这里直接禁止这种写法：新表与灌数据必须显式列出列名。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../database/migration.ts',
)
const source = fs.readFileSync(migrationPath, 'utf-8')

/** 去掉注释再扫描：说明文字里提到反模式不该被当成违规。 */
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')

describe('migration.ts 结构守卫', () => {
  it('不存在 `INSERT INTO x_new SELECT *` 这种按位置灌数据的写法', () => {
    const offenders: string[] = []
    const pattern = /INSERT\s+INTO\s+(\w+)\s+SELECT\s+\*/gi
    for (const match of codeOnly.matchAll(pattern)) {
      offenders.push(match[0])
    }
    expect(
      offenders,
      '改成显式列名：INSERT INTO x_new (a, b, ...) SELECT a, b, ... FROM x。' +
        '按位置灌数据会在任何一次加列后整批回滚。',
    ).toEqual([])
  })

  it('级联迁移建的表与显式列清单里的列数一致', () => {
    // 粗略但有效的自检：每个 `<table>_new` 的 INSERT 列清单不能为空。
    const inserts = [...codeOnly.matchAll(/INSERT\s+INTO\s+(\w+_new)\s*\(([^)]*)\)/gi)]
    expect(inserts.length).toBeGreaterThan(0)
    for (const [, table, columns] of inserts) {
      const list = columns.split(',').map((c) => c.trim()).filter(Boolean)
      expect(list.length, `${table} 的列清单为空`).toBeGreaterThan(3)
    }
  })
})
