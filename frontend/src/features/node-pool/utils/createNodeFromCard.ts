import type { Node, NodeCard } from '@/types'
import { normalizeNode } from '@shared/node'
import { NODE_DEFAULTS } from '@/constants'

/**
 * Parse a node pool card's JSON content into partial node data.
 * Falls back to a minimal text node if parsing fails.
 */
export function parseCardNodeData(card: NodeCard): Partial<Node> {
  try {
    return JSON.parse(card.content) as Partial<Node>
  } catch {
    return {
      type: 'text',
      title: card.name || '未知节点',
      content: card.content || '',
      imageUrl: null,
      width: 200,
      height: 120,
    }
  }
}

/**
 * Create a new canvas node from a node pool card.
 *
 * A fresh node ID is always generated so the same card can be used multiple times
 * without collisions. Position is supplied by the caller (drop location,
 * context-menu position, etc.).
 *
 * Style defaults matter here: older cards — and cards created by the MCP tools or the
 * manuscript converter — only carry `{title, content, cover}`, because they were never
 * a node on a canvas. Without `color` the node renders with no background at all
 * (`NodeItem` paints `backgroundColor: node.color`), which looks like a half-transparent
 * card on top of the canvas grid. Filling the same defaults a freshly created node gets
 * makes a card-dropped node visually identical to any other node.
 */
export function createNodeFromCard(
  card: NodeCard,
  position: { x: number; y: number }
): Node {
  // `JSON.parse('null')` 是合法 JSON，但会解析出 null —— 这里必须兜底成空对象，
  // 否则下面的 nodeData.color 会直接抛异常（既有测试 "内容 'null'" 覆盖了这个边界）。
  const nodeData = parseCardNodeData(card) || {}

  const baseNode: Node = {
    id: `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    x: position.x,
    y: position.y,
    width: NODE_DEFAULTS.WIDTH,
    height: 120,
    title: '',
    content: '',
    color: NODE_DEFAULTS.COLOR,
    fontSize: NODE_DEFAULTS.FONT_SIZE,
    textAlign: 'left',
    collapsed: false,
    locked: false,
  }

  // 卡片内容可能是统一改造前存的（type/imageUrl），这里折成 content/cover。
  return normalizeNode({
    ...baseNode,
    ...nodeData,
    id: baseNode.id,
    x: baseNode.x,
    y: baseNode.y,
    // 卡片里没有样式字段时用默认值补齐；有的话保留卡片自己的
    color: nodeData.color || baseNode.color,
  })
}
