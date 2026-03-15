// Web Worker for canvas calculations
// This worker runs in a separate thread to offload heavy computations from the main thread

// Define types locally to avoid import issues in worker
interface Node {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  content: string
  color?: string
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  collapsed: boolean
  locked: boolean
  type?: 'text' | 'image'
  imageUrl?: string
  aspectRatio?: number
}

interface Connection {
  id: string
  fromNodeId: string
  toNodeId: string
  type: 'straight' | 'curve' | 'step'
  color?: string
  width?: number
  style?: 'solid' | 'dashed' | 'dotted'
  arrowType?: 'none' | 'end' | 'start' | 'both'
  label?: string
  bendPoints?: Array<{ x: number; y: number }>
}

interface PathCalculationRequest {
  type: 'calculatePath'
  id: string
  connection: Connection
  nodes: Map<string, Node>
}

interface BatchPathCalculationRequest {
  type: 'calculatePaths'
  connections: Array<{ id: string; connection: Connection }>
  nodes: Map<string, Node>
}

interface BoundsCalculationRequest {
  type: 'calculateBounds'
  nodes: Map<string, Node>
  padding?: number
}

interface LayoutCalculationRequest {
  type: 'calculateLayout'
  nodes: Map<string, Node>
  connections: Map<string, Connection>
  layoutType: 'force' | 'hierarchical' | 'circular'
  width: number
  height: number
}

type WorkerRequest =
  | PathCalculationRequest
  | BatchPathCalculationRequest
  | BoundsCalculationRequest
  | LayoutCalculationRequest

interface WorkerResponse {
  id?: string
  type: string
  data: unknown
  error?: string
}

// Convert plain object to Map (for deserialization)
function toMap<K, V>(obj: Record<string, V>): Map<K, V> {
  const map = new Map<K, V>()
  Object.entries(obj).forEach(([key, value]) => {
    map.set(key as K, value)
  })
  return map
}

// Calculate connection path
function calculateConnectionPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  type: string
): string {
  switch (type) {
    case 'curve': {
      const dx = toX - fromX
      const dy = toY - fromY
      const distance = Math.sqrt(dx * dx + dy * dy)
      const controlOffset = Math.min(distance * 0.5, 100)
      const dirX = dx >= 0 ? 1 : -1
      return `M ${fromX} ${fromY} C ${fromX + controlOffset * dirX} ${fromY}, ${toX - controlOffset * dirX} ${toY}, ${toX} ${toY}`
    }
    case 'step': {
      const midX = (fromX + toX) / 2
      return `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`
    }
    default:
      return `M ${fromX} ${fromY} L ${toX} ${toY}`
  }
}

// Calculate single connection path
function calculatePath(
  connection: Connection,
  nodes: Map<string, Node>
): { id: string; path: string } | null {
  const fromNode = nodes.get(connection.fromNodeId)
  const toNode = nodes.get(connection.toNodeId)

  if (!fromNode || !toNode) return null

  const fromX = fromNode.x + fromNode.width / 2
  const fromY = fromNode.y + fromNode.height / 2
  const toX = toNode.x + toNode.width / 2
  const toY = toNode.y + toNode.height / 2

  const path = calculateConnectionPath(fromX, fromY, toX, toY, connection.type)

  return { id: connection.id, path }
}

// Batch calculate connection paths
function calculatePaths(
  connections: Array<{ id: string; connection: Connection }>,
  nodes: Map<string, Node>
): Array<{ id: string; path: string }> {
  const results: Array<{ id: string; path: string }> = []

  for (const { connection } of connections) {
    const result = calculatePath(connection, nodes)
    if (result) {
      results.push(result)
    }
  }

  return results
}

// Calculate content bounds
function calculateBounds(
  nodes: Map<string, Node>,
  padding = 50
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (nodes.size === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  nodes.forEach((node) => {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  })

  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  }
}

// Simple force-directed layout
function calculateForceLayout(
  nodes: Map<string, Node>,
  connections: Map<string, Connection>,
  width: number,
  height: number
): Map<string, { x: number; y: number }> {
  const nodePositions = new Map<string, { x: number; y: number }>()
  const nodeArray = Array.from(nodes.entries())

  // Initialize positions
  nodeArray.forEach(([id], index) => {
    const angle = (index / nodeArray.length) * 2 * Math.PI
    const radius = Math.min(width, height) * 0.3
    nodePositions.set(id, {
      x: width / 2 + radius * Math.cos(angle),
      y: height / 2 + radius * Math.sin(angle),
    })
  })

  // Simple force-directed iterations
  const iterations = 50
  for (let i = 0; i < iterations; i++) {
    // Repulsion
    nodeArray.forEach(([id1]) => {
      const pos1 = nodePositions.get(id1)!
      let fx = 0
      let fy = 0

      nodeArray.forEach(([id2]) => {
        if (id1 === id2) return
        const pos2 = nodePositions.get(id2)!
        const dx = pos1.x - pos2.x
        const dy = pos1.y - pos2.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = 1000 / (dist * dist)
        fx += (dx / dist) * force
        fy += (dy / dist) * force
      })

      // Attraction (connected nodes)
      connections.forEach((conn) => {
        if (conn.fromNodeId === id1) {
          const pos2 = nodePositions.get(conn.toNodeId)
          if (pos2) {
            const dx = pos2.x - pos1.x
            const dy = pos2.y - pos1.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            const force = dist * 0.01
            fx += (dx / dist) * force
            fy += (dy / dist) * force
          }
        }
      })

      // Update position
      pos1.x += fx * 0.1
      pos1.y += fy * 0.1

      // Boundary constraints
      pos1.x = Math.max(50, Math.min(width - 50, pos1.x))
      pos1.y = Math.max(50, Math.min(height - 50, pos1.y))
    })
  }

  return nodePositions
}

// Worker message handler
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  try {
    // Convert plain objects to Maps (data from main thread is serialized)
    const nodesMap = request.nodes ? toMap<string, Node>(request.nodes as unknown as Record<string, Node>) : new Map()
    const connectionsMap = 'connections' in request && request.connections
      ? toMap<string, Connection>(request.connections as unknown as Record<string, Connection>)
      : new Map()

    switch (request.type) {
      case 'calculatePath': {
        const result = calculatePath(request.connection, nodesMap)
        const response: WorkerResponse = {
          id: request.id,
          type: 'pathResult',
          data: result,
        }
        self.postMessage(response)
        break
      }

      case 'calculatePaths': {
        const results = calculatePaths(request.connections, nodesMap)
        const response: WorkerResponse = {
          type: 'pathsResult',
          data: results,
        }
        self.postMessage(response)
        break
      }

      case 'calculateBounds': {
        const bounds = calculateBounds(nodesMap, request.padding)
        const response: WorkerResponse = {
          type: 'boundsResult',
          data: bounds,
        }
        self.postMessage(response)
        break
      }

      case 'calculateLayout': {
        let layout: Map<string, { x: number; y: number }>
        switch (request.layoutType) {
          case 'force':
            layout = calculateForceLayout(
              nodesMap,
              connectionsMap,
              request.width,
              request.height
            )
            break
          default:
            layout = calculateForceLayout(
              nodesMap,
              connectionsMap,
              request.width,
              request.height
            )
        }
        const response: WorkerResponse = {
          type: 'layoutResult',
          data: Array.from(layout.entries()),
        }
        self.postMessage(response)
        break
      }

      default:
        self.postMessage({
          type: 'error',
          data: null,
          error: `Unknown request type`,
        } as WorkerResponse)
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'error',
      data: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    self.postMessage(response)
  }
}

export { }
