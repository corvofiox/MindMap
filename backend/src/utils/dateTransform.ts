/**
 * 将数据库返回的时间戳字段转换为 ISO 字符串
 * 处理可能存在的 Unix 时间戳（数字）和 Date 对象
 */
export function transformDateFields<T extends Record<string, any>>(
  obj: T,
  dateFields: (keyof T)[]
): T {
  const result = { ...obj }

  for (const field of dateFields) {
    const value = result[field]
    if (value === null || value === undefined) {
      continue
    }

    // 如果是 Date 对象，直接转为 ISO 字符串
    if (typeof value === 'object' && value !== null && 'getTime' in value) {
      const dateValue = value as Date
      // 检查 Date 是否有效
      if (!isNaN(dateValue.getTime())) {
        result[field] = dateValue.toISOString() as T[keyof T]
      }
      continue
    }

    // 如果是数字（Unix 时间戳秒），转换为 ISO 字符串
    if (typeof value === 'number') {
      // 检查是否是合理的 Unix 时间戳（10位是秒，13位是毫秒）
      if (value > 1000000000000) {
        // 毫秒时间戳
        result[field] = new Date(value).toISOString() as T[keyof T]
      } else if (value > 1000000000) {
        // 秒时间戳
        result[field] = new Date(value * 1000).toISOString() as T[keyof T]
      } else {
        // 无效时间戳（0 或太小），使用当前时间
        result[field] = new Date().toISOString() as T[keyof T]
      }
      continue
    }

    // 如果已经是字符串，尝试解析并重新格式化
    if (typeof value === 'string') {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        result[field] = date.toISOString() as T[keyof T]
      }
    }
  }

  return result
}

/**
 * 批量转换数组中的对象时间戳字段
 */
export function transformDateFieldsArray<T extends Record<string, any>>(
  arr: T[],
  dateFields: (keyof T)[]
): T[] {
  return arr.map((item) => transformDateFields(item, dateFields))
}
