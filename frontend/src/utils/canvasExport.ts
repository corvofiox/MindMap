import type { Node, Connection, NodeGroup, Domain } from '@/types'
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

function sanitizeNode(raw: unknown): Node | null {
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
    type: raw.type === 'image' ? 'image' : 'text',
    imageUrl: isNonEmptyString(raw.imageUrl) ? raw.imageUrl : undefined,
    aspectRatio: isNumber(raw.aspectRatio) ? raw.aspectRatio : undefined,
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

export function exportCanvas(
  nodes: Map<string, Node>,
  connections: Map<string, Connection>,
  groups: Map<string, NodeGroup>,
  domains: Map<string, Domain>,
  viewState?: { zoom: number; panX: number; panY: number },
): string {
  const exportData: ExportData = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    app: EXPORT_APP,
    data: {
      nodes: Array.from(nodes.values()),
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
      const sanitized = sanitizeNode(raw)
      if (sanitized) nodes.push(sanitized)
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
