import type { Node, NodeCard } from '@/types'

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
 * A fresh node ID is always generated so the same card can be used multiple
 * times without collisions. Position is supplied by the caller (drop location,
 * context-menu position, etc.).
 */
export function createNodeFromCard(
  card: NodeCard,
  position: { x: number; y: number }
): Node {
  const nodeData = parseCardNodeData(card)

  const baseNode: Node = {
    id: `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    x: position.x,
    y: position.y,
    width: 200,
    height: 120,
    title: '',
    content: '',
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
  }

  return {
    ...baseNode,
    ...nodeData,
    id: baseNode.id,
    x: baseNode.x,
    y: baseNode.y,
  }
}
