import { transformDateFields, transformDateFieldsArray } from './dateTransform.js'

/**
 * 安全获取属性值，兼容 snake_case 和 camelCase 命名
 * 用于处理 Drizzle ORM 返回数据可能的字段命名不一致问题
 *
 * @example getProperty<number>(project, 'owner_id', 'ownerId')
 */
export function getProperty<T>(obj: any, ...keys: string[]): T | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined) {
      return value as T
    }
  }
  return undefined
}

/**
 * 安全获取 userId，兼容 snake_case 和 camelCase
 */
export function getUserId(obj: Record<string, any> | null | undefined): number | undefined {
  if (!obj) return undefined
  return obj.userId ?? obj.user_id
}

/**
 * 将下划线命名转换为驼峰命名
 *
 * B19: 递归深度受限。列表接口（如 GET /projects/:id/canvases）会对每条记录
 * 调用本函数，若记录携带深层嵌套的大对象，无界递归既浪费 CPU 也可能爆栈。
 * 超过 MAX_CAMEL_DEPTH 层的子树保持原样（不再改键名）——业务数据的键名
 * 转换只发生在浅层（画布/节点/项目等实体通常不超过 3-4 层）。
 */
const MAX_CAMEL_DEPTH = 8

function toCamelCase(obj: Record<string, any>, depth: number = 0): Record<string, any> {
  if (depth >= MAX_CAMEL_DEPTH) {
    return obj
  }
  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
      const value = obj[key]

      // 递归处理嵌套对象
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[camelKey] = toCamelCase(value, depth + 1)
      } else if (Array.isArray(value)) {
        result[camelKey] = value.map(item =>
          typeof item === 'object' && item !== null ? toCamelCase(item, depth + 1) : item
        )
      } else {
        result[camelKey] = value
      }
    }
  }

  return result
}

/**
 * 转换响应数据：
 * 1. 将下划线命名转换为驼峰命名
 * 2. 转换时间戳字段为 ISO 字符串
 */
export function transformResponse<T extends Record<string, any>>(
  obj: T,
  dateFields: string[] = []
): T {
  const camelCased = toCamelCase(obj)
  if (dateFields.length > 0) {
    return transformDateFields(camelCased, dateFields as any) as T
  }
  return camelCased as T
}

/**
 * 批量转换响应数据数组
 */
export function transformResponseArray<T extends Record<string, any>>(
  arr: T[],
  dateFields: string[] = []
): T[] {
  const camelCased = arr.map(item => toCamelCase(item))
  if (dateFields.length > 0) {
    return transformDateFieldsArray(camelCased, dateFields as any) as T[]
  }
  return camelCased as T[]
}
