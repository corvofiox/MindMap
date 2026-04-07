import type { Node, Connection, NodeGroup, Domain } from '@/types'

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

export function exportCanvas(
  nodes: Map<string, Node>,
  connections: Map<string, Connection>,
  groups: Map<string, NodeGroup>,
  domains: Map<string, Domain>,
  viewState?: { zoom: number; panX: number; panY: number }
): string {
  const exportData: ExportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    app: 'mindmap',
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

export function importCanvas(jsonString: string): ExportData['data'] | null {
  try {
    const data: ExportData = JSON.parse(jsonString)

    if (!data.version || !data.data) {
      throw new Error('Invalid file format')
    }

    return data.data
  } catch {
    return null
  }
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
