import type { Node, Connection, NodeGroup, Domain } from '@/types'
import { NODE_Z_STEP } from '@shared/z-order'
import { normalizeNode } from '@shared/node'
import {
  CANVAS_DEFAULTS,
  NODE_DEFAULTS,
  GROUP_DEFAULTS,
  DOMAIN_DEFAULTS,
  CONNECTION_DEFAULTS,
} from '@/constants'

export const EXPORT_VERSION = '1.0'
export const EXPORT_APP = 'mindmap'

export interface ExportData {
  version: string
  exportedAt: string
  app: string
  data: {
    nodes: Node[]
    connections: Connection[]
    groups: NodeGroup[]
    domains: Domain[]
  }
  viewState?: {
    zoom: number
    panX: number
    panY: number
  }
}

export interface ImportResult {
  success: boolean
  data?: ExportData['data']
  viewState?: ExportData['viewState']
  error?: string
}

const VALID_PORTS = ['top', 'right', 'bottom', 'left'] as const
const VALID_CONNECTION_TYPES = ['straight', 'curve', 'step'] as const
const VALID_CONNECTION_STYLES = ['solid', 'dashed', 'dotted'] as const
const VALID_ARROW_TYPES = ['none', 'start', 'end', 'both'] as const
const VALID_DIRECTIONS = ['directed', 'bidirectional', 'undirected'] as const
const VALID_TEXT_ALIGNS = ['left', 'center', 'right'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (!isNumber(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function pickString<T extends string>(
  value: unknown,
  valid: readonly T[],
  fallback: T,
): T {
  if (typeof value !== 'string') return fallback
  return valid.includes(value as T) ? (value as T) : fallback
}

function sanitizeNode(raw: unknown, index: number): Node | null {
  if (!isPlainObject(raw)) return null
  const id = raw.id
  if (!isNonEmptyString(id)) return null

  return {
    id,
    x: isNumber(raw.x) ? raw.x : 0,
    y: isNumber(raw.y) ? raw.y : 0,
    width: clampNumber(raw.width, NODE_DEFAULTS.MIN_WIDTH, Infinity, NODE_DEFAULTS.WIDTH),
    height: clampNumber(raw.height, NODE_DEFAULTS.MIN_HEIGHT, Infinity, NODE_DEFAULTS.HEIGHT),
    title: isNonEmptyString(raw.title) ? raw.title : '',
    content: isNonEmptyString(raw.content) ? raw.content : '',
    color: isNonEmptyString(raw.color) ? raw.color : NODE_DEFAULTS.COLOR,
    fontSize: clampNumber(raw.fontSize, 8, 72, NODE_DEFAULTS.FONT_SIZE),
    textAlign: pickString(raw.textAlign, VALID_TEXT_ALIGNS, NODE_DEFAULTS.TEXT_ALIGN),
    titleAlign: raw.titleAlign !== undefined
      ? pickString(raw.titleAlign, VALID_TEXT_ALIGNS, NODE_DEFAULTS.TEXT_ALIGN)
      : undefined,
    collapsedTitleAlign: raw.collapsedTitleAlign !== undefined
      ? pickString(raw.collapsedTitleAlign, VALID_TEXT_ALIGNS, NODE_DEFAULTS.TEXT_ALIGN)
      : undefined,
    contentAlign: raw.contentAlign !== undefined
      ? pickString(raw.contentAlign, VALID_TEXT_ALIGNS, NODE_DEFAULTS.TEXT_ALIGN)
      : undefined,
    collapsed: isBoolean(raw.collapsed) ? raw.collapsed : false,
    locked: isBoolean(raw.locked) ? raw.locked : false,
    expandedHeight: isNumber(raw.expandedHeight) ? raw.expandedHeight : undefined,

    // 兼容导入老文件：imageUrl 会在 normalizeNode 里折成 content/cover
    imageUrl: isNonEmptyString(raw.imageUrl) ? raw.imageUrl : undefined,
    aspectRatio: isNumber(raw.aspectRatio) ? raw.aspectRatio : undefined,
    // 导入的文件可能没有层序字段：按数组顺序固化，保留导出时的绘制次序。
    zIndex: isNumber(raw.zIndex) ? raw.zIndex : index * NODE_Z_STEP,
    _version: isNumber(raw._version) ? raw._version : undefined,
  }
}

function sanitizeConnection(raw: unknown): Connection | null {
  if (!isPlainObject(raw)) return null
  const id = raw.id
  const fromNodeId = raw.fromNodeId
  const toNodeId = raw.toNodeId
  if (!isNonEmptyString(id) || !isNonEmptyString(fromNodeId) || !isNonEmptyString(toNodeId)) {
    return null
  }

  const bendPoints: Connection['bendPoints'] = []
  if (Array.isArray(raw.bendPoints)) {
    for (const bp of raw.bendPoints) {
      if (
        isPlainObject(bp) &&
        isNonEmptyString(bp.id) &&
        isNumber(bp.x) &&
        isNumber(bp.y)
      ) {
        bendPoints.push({ id: bp.id, x: bp.x, y: bp.y })
      }
    }
  }

  return {
    id,
    fromNodeId,
    toNodeId,
    fromPort: pickString(raw.fromPort, VALID_PORTS, 'right'),
    toPort: pickString(raw.toPort, VALID_PORTS, 'left'),
    type: pickString(raw.type, VALID_CONNECTION_TYPES, CONNECTION_DEFAULTS.TYPE),
    style: pickString(raw.style, VALID_CONNECTION_STYLES, CONNECTION_DEFAULTS.STYLE),
    color: isNonEmptyString(raw.color) ? raw.color : CONNECTION_DEFAULTS.COLOR,
    width: clampNumber(raw.width, 1, 20, CONNECTION_DEFAULTS.WIDTH),
    arrowType: pickString(raw.arrowType, VALID_ARROW_TYPES, CONNECTION_DEFAULTS.ARROW_TYPE),
    direction: pickString(raw.direction, VALID_DIRECTIONS, 'directed'),
    label: isNonEmptyString(raw.label) ? raw.label : undefined,
    bendPoints: bendPoints.length > 0 ? bendPoints : undefined,
  }
}

function sanitizeGroup(raw: unknown): NodeGroup | null {
  if (!isPlainObject(raw)) return null
  const id = raw.id
  if (!isNonEmptyString(id)) return null

  const nodeIds: string[] = []
  if (Array.isArray(raw.nodeIds)) {
    for (const nodeId of raw.nodeIds) {
      if (isNonEmptyString(nodeId)) nodeIds.push(nodeId)
    }
  }

  return {
    id,
    name: isNonEmptyString(raw.name) ? raw.name : '组',
    description: isNonEmptyString(raw.description) ? raw.description : undefined,
    x: isNumber(raw.x) ? raw.x : 0,
    y: isNumber(raw.y) ? raw.y : 0,
    width: clampNumber(raw.width, 10, Infinity, 200),
    height: clampNumber(raw.height, 10, Infinity, 150),
    borderColor: isNonEmptyString(raw.borderColor) ? raw.borderColor : GROUP_DEFAULTS.BORDER_COLOR,
    backgroundColor: isNonEmptyString(raw.backgroundColor)
      ? raw.backgroundColor
      : GROUP_DEFAULTS.BACKGROUND_COLOR,
    borderWidth: clampNumber(raw.borderWidth, 0, 20, GROUP_DEFAULTS.BORDER_WIDTH),
    borderRadius: clampNumber(raw.borderRadius, 0, 100, GROUP_DEFAULTS.BORDER_RADIUS),
    nodeIds,
    collapsed: isBoolean(raw.collapsed) ? raw.collapsed : false,
  }
}

function sanitizeDomain(raw: unknown): Domain | null {
  if (!isPlainObject(raw)) return null
  const id = raw.id
  if (!isNonEmptyString(id)) return null

  return {
    id,
    name: isNonEmptyString(raw.name) ? raw.name : '域',
    x: isNumber(raw.x) ? raw.x : 0,
    y: isNumber(raw.y) ? raw.y : 0,
    width: clampNumber(raw.width, 10, Infinity, 200),
    height: clampNumber(raw.height, 10, Infinity, 150),
    backgroundColor: isNonEmptyString(raw.backgroundColor)
      ? raw.backgroundColor
      : DOMAIN_DEFAULTS.BACKGROUND_COLOR,
    titleVisible: isBoolean(raw.titleVisible) ? raw.titleVisible : true,
    titleColor: isNonEmptyString(raw.titleColor) ? raw.titleColor : undefined,
    titleFontSize: isNumber(raw.titleFontSize) ? raw.titleFontSize : undefined,
    titleScale: isNumber(raw.titleScale) ? raw.titleScale : undefined,
  }
}

function sanitizeViewState(raw: unknown): ExportData['viewState'] | undefined {
  if (!isPlainObject(raw)) return undefined
  const zoom = clampNumber(
    raw.zoom,
    CANVAS_DEFAULTS.MIN_ZOOM,
    CANVAS_DEFAULTS.MAX_ZOOM,
    CANVAS_DEFAULTS.DEFAULT_ZOOM,
  )
  const panX = isNumber(raw.panX) ? raw.panX : 0
  const panY = isNumber(raw.panY) ? raw.panY : 0
  return { zoom, panX, panY }
}

function validateExportData(data: ExportData['data']): string | null {
  const nodeIds = new Set(data.nodes.map((n) => n.id))

  for (const conn of data.connections) {
    if (!nodeIds.has(conn.fromNodeId)) {
      return `连线 ${conn.id} 引用了不存在的起始节点 ${conn.fromNodeId}`
    }
    if (!nodeIds.has(conn.toNodeId)) {
      return `连线 ${conn.id} 引用了不存在的目标节点 ${conn.toNodeId}`
    }
  }

  for (const group of data.groups) {
    for (const nodeId of group.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        return `组 ${group.id} 引用了不存在的节点 ${nodeId}`
      }
    }
  }

  return null
}

const FILE_REF = /\/api\/files\/([a-f0-9]{64})/g

/**
 * Blob → data URL。
 *
 * 不用 FileReader：它在 jsdom 里对 Node 的 Blob 行为不一致，测试拿不到结果；
 * arrayBuffer + btoa 在浏览器与测试环境里语义一致。
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

/**
 * 把 `/api/files/<sha>` 引用换成内联 base64。
 *
 * 导出文件要能脱离本实例使用：只带短 URL 的话，换一台机器导入就全是裂图。
 * 同一张图只取一次（去重后的 sha 天然相同）；取不到时保留原 URL 并继续，
 * 宁可少内联一张，也不让整个导出失败。
 */
async function inlineFileRefs(value: string, cache: Map<string, string>): Promise<string> {
  if (!value || !value.includes('/api/files/')) return value
  const shas = new Set(Array.from(value.matchAll(FILE_REF)).map((m) => m[1]))
  let out = value
  for (const sha of shas) {
    let dataUrl = cache.get(sha)
    if (!dataUrl) {
      try {
        const response = await fetch(`/api/files/${sha}`)
        if (!response.ok) continue
        dataUrl = await blobToDataUrl(await response.blob())
        cache.set(sha, dataUrl)
      } catch {
        continue
      }
    }
    out = out.split(`/api/files/${sha}`).join(dataUrl)
  }
  return out
}

/**
 * 导出为自包含 JSON。
 *
 * 异步是因为要把图片取回来内联（见 inlineFileRefs）。调用方需要 await。
 */
export async function exportCanvas(
  nodes: Map<string, Node>,
  connections: Map<string, Connection>,
  groups: Map<string, NodeGroup>,
  domains: Map<string, Domain>,
  viewState?: { zoom: number; panX: number; panY: number },
): Promise<string> {
  const cache = new Map<string, string>()
  const exportNodes = await Promise.all(
    Array.from(nodes.values()).map(async (node) => {
      const content = await inlineFileRefs(node.content ?? '', cache)
      const cover = node.cover ? await inlineFileRefs(node.cover, cache) : node.cover
      return { ...node, content, ...(cover ? { cover } : {}) }
    }),
  )

  const exportData: ExportData = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    app: EXPORT_APP,
    data: {
      nodes: exportNodes,
      connections: Array.from(connections.values()),
      groups: Array.from(groups.values()),
      domains: Array.from(domains.values()),
    },
    viewState,
  }

  return JSON.stringify(exportData, null, 2)
}

export function importCanvas(jsonString: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonString)
  } catch {
    return { success: false, error: '文件不是有效的 JSON' }
  }

  if (!isPlainObject(parsed)) {
    return { success: false, error: '文件格式不正确' }
  }

  if (!isNonEmptyString(parsed.version)) {
    return { success: false, error: '缺少版本号' }
  }

  if (parsed.app !== undefined && parsed.app !== EXPORT_APP) {
    return { success: false, error: `不兼容的应用标识：${parsed.app}` }
  }

  if (parsed.version !== EXPORT_VERSION) {
    return { success: false, error: `不支持的文件版本：${parsed.version}` }
  }

  const rawData = parsed.data
  if (!isPlainObject(rawData)) {
    return { success: false, error: '缺少画布数据' }
  }

  const nodes: Node[] = []
  if (Array.isArray(rawData.nodes)) {
    for (const raw of rawData.nodes) {
      const rawNode = sanitizeNode(raw, nodes.length)
      if (rawNode) nodes.push(normalizeNode(rawNode))
    }
  }

  const connections: Connection[] = []
  if (Array.isArray(rawData.connections)) {
    for (const raw of rawData.connections) {
      const sanitized = sanitizeConnection(raw)
      if (sanitized) connections.push(sanitized)
    }
  }

  const groups: NodeGroup[] = []
  if (Array.isArray(rawData.groups)) {
    for (const raw of rawData.groups) {
      const sanitized = sanitizeGroup(raw)
      if (sanitized) groups.push(sanitized)
    }
  }

  const domains: Domain[] = []
  if (Array.isArray(rawData.domains)) {
    for (const raw of rawData.domains) {
      const sanitized = sanitizeDomain(raw)
      if (sanitized) domains.push(sanitized)
    }
  }

  const data: ExportData['data'] = { nodes, connections, groups, domains }
  const referenceError = validateExportData(data)
  if (referenceError) {
    return { success: false, error: referenceError }
  }

  const viewState = sanitizeViewState(parsed.viewState)

  return { success: true, data, viewState }
}

export function downloadJsonFile(jsonString: string, filename: string) {
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function readJsonFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      resolve(e.target?.result as string)
    }
    reader.onerror = (e) => {
      reject(e)
    }
    reader.readAsText(file)
  })
}
