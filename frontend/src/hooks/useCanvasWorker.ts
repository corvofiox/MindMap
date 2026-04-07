import { useRef, useCallback, useEffect } from 'react'
import type { Connection, Node } from '@/types'

interface PathResult {
  id: string
  path: string
}

interface BoundsResult {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type WorkerMessageHandler = (event: MessageEvent) => void

export function useCanvasWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRequestsRef = useRef<Map<string, (data: unknown) => void>>(new Map())
  const messageHandlerRef = useRef<WorkerMessageHandler | null>(null)
  const timeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const clearTimeouts = useCallback(() => {
    timeoutIdsRef.current.forEach(id => clearTimeout(id))
    timeoutIdsRef.current.clear()
  }, [])

  useEffect(() => {
    return () => {
      clearTimeouts()
    }
  }, [clearTimeouts])

  // 初始化 Worker
  useEffect(() => {
    // 使用 Vite 的 Worker 导入方式
    const worker = new Worker(new URL('@/workers/canvas.worker.ts', import.meta.url), {
      type: 'module',
    })

    workerRef.current = worker

    messageHandlerRef.current = (event: MessageEvent) => {
      const { id, type, data, error } = event.data

      if (error) {
        if (id && pendingRequestsRef.current.has(id)) {
          pendingRequestsRef.current.delete(id)
        }
        return
      }

      // 处理批量路径计算结果
      if (type === 'pathsResult' && Array.isArray(data)) {
        data.forEach((item: PathResult) => {
          if (pendingRequestsRef.current.has(item.id)) {
            const resolve = pendingRequestsRef.current.get(item.id)!
            resolve(item.path)
            pendingRequestsRef.current.delete(item.id)
          }
        })
        return
      }

      // 处理单个请求结果
      if (id && pendingRequestsRef.current.has(id)) {
        const resolve = pendingRequestsRef.current.get(id)!
        resolve(data)
        pendingRequestsRef.current.delete(id)
      }
    }

    worker.addEventListener('message', messageHandlerRef.current)

    return () => {
      if (messageHandlerRef.current) {
        worker.removeEventListener('message', messageHandlerRef.current)
      }
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  // 计算单个连接路径
  const calculatePath = useCallback(
    (connection: Connection, nodes: Map<string, Node>): Promise<string | null> => {
      return new Promise((resolve) => {
        if (!workerRef.current) {
          resolve(null)
          return
        }

        pendingRequestsRef.current.set(connection.id, resolve as (data: unknown) => void)

        workerRef.current.postMessage({
          type: 'calculatePath',
          id: connection.id,
          connection,
          nodes,
        })
      })
    },
    []
  )

  // 批量计算连接路径
  const calculatePaths = useCallback(
    (
      connections: Map<string, Connection>,
      nodes: Map<string, Node>
    ): Promise<Map<string, string>> => {
      return new Promise((resolve) => {
        if (!workerRef.current || connections.size === 0) {
          resolve(new Map())
          return
        }

        const results = new Map<string, string>()
        const connectionArray = Array.from(connections.entries())

        // 为每个连接注册回调
        connectionArray.forEach(([id]) => {
          pendingRequestsRef.current.set(
            id,
            (path: unknown) => {
              if (typeof path === 'string') {
                results.set(id, path)
              }
            }
          )
        }
        )

        // 设置超时处理
        const timeoutId = setTimeout(() => {
          timeoutIdsRef.current.delete(timeoutId)
          resolve(results)
        }, 1000)
        timeoutIdsRef.current.add(timeoutId)

        workerRef.current.postMessage({
          type: 'calculatePaths',
          connections: connectionArray.map(([id, conn]) => ({ id, connection: conn })),
          nodes,
        })
      })
    },
    []
  )

  // 计算内容边界
  const calculateBounds = useCallback(
    (nodes: Map<string, Node>, padding?: number): Promise<BoundsResult | null> => {
      return new Promise((resolve) => {
        if (!workerRef.current) {
          resolve(null)
          return
        }

        const requestId = `bounds-${Date.now()}`
        pendingRequestsRef.current.set(requestId, resolve as (data: unknown) => void)

        const timeoutId = setTimeout(() => {
          timeoutIdsRef.current.delete(timeoutId)
          if (pendingRequestsRef.current.has(requestId)) {
            pendingRequestsRef.current.delete(requestId)
            resolve(null)
          }
        }, 5000)
        timeoutIdsRef.current.add(timeoutId)

        workerRef.current.postMessage({
          type: 'calculateBounds',
          id: requestId,
          nodes,
          padding,
        })
      })
    },
    []
  )

  // 计算布局
  const calculateLayout = useCallback(
    (
      nodes: Map<string, Node>,
      connections: Map<string, Connection>,
      layoutType: 'force' | 'hierarchical' | 'circular' = 'force',
      width: number,
      height: number
    ): Promise<Map<string, { x: number; y: number }>> => {
      return new Promise((resolve) => {
        if (!workerRef.current) {
          resolve(new Map())
          return
        }

        const requestId = `layout-${Date.now()}`

        pendingRequestsRef.current.set(requestId, (data: unknown) => {
          if (Array.isArray(data)) {
            const result = new Map<string, { x: number; y: number }>()
            data.forEach(([id, position]: [string, { x: number; y: number }]) => {
              result.set(id, position)
            })
            resolve(result)
          } else {
            resolve(new Map())
          }
        })

        // 设置超时
        setTimeout(() => {
          if (pendingRequestsRef.current.has(requestId)) {
            pendingRequestsRef.current.delete(requestId)
            resolve(new Map())
          }
        }, 10000)

        workerRef.current.postMessage({
          type: 'calculateLayout',
          id: requestId,
          nodes,
          connections,
          layoutType,
          width,
          height,
        })
      })
    },
    []
  )

  return {
    calculatePath,
    calculatePaths,
    calculateBounds,
    calculateLayout,
  }
}
