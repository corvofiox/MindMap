import { transformDateFields, transformDateFieldsArray } from './dateTransform.js'

/**
 * 安全获取 userId，兼容 snake_case 和 camelCase
 * 用于处理 Drizzle ORM 返回数据可能的字段命名不一致问题
 */
export function getUserId(obj: Record<string, any> | null | undefined): number | undefined {
  if (!obj) return undefined
  return obj.userId ?? obj.user_id
}

/**
 * 将下划线命名转换为驼峰命名
 */
function toCamelCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
      const value = obj[key]

      // 递归处理嵌套对象
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[camelKey] = toCamelCase(value)
      } else if (Array.isArray(value)) {
        result[camelKey] = value.map(item =>
          typeof item === 'object' && item !== null ? toCamelCase(item) : item
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
