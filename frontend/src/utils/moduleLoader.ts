/**
 * 模块动态加载器
 * 使用 import.meta.glob 在构建时预先收集模块，避免运行时路径解析问题
 */

// 预收集所有 API 模块（懒加载模式）
const apiModules = import.meta.glob('../services/api.ts', { eager: false })

// 预收集所有 UI Store 模块（懒加载模式）
const storeModules = import.meta.glob('../store/*.ts', { eager: false })

/**
 * 动态加载 API 模块
 * @returns API 模块
 */
export async function loadApiModule() {
  const modulePath = '../services/api.ts'
  const module = await apiModules[modulePath]()
  return module
}

/**
 * 动态加载 UI Store 模块
 * @returns UI Store 模块
 */
export async function loadUIStore() {
  const modulePath = '../store/useUIStore.ts'
  const module = await storeModules[modulePath]()
  return module
}

/**
 * 延迟加载工具函数
 * 用于在需要时才加载某些大型模块
 */
export const lazyModules = {
  // 预留：可以添加其他大型模块的懒加载
  // 例如图表库、编辑器等
}
