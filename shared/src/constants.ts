// Shared constants between frontend and backend

export interface TextNodeDefaults {
  width: number
  height: number
  color: string
  fontSize: number
  titleAlign: 'left' | 'center' | 'right'
  collapsedTitleAlign: 'left' | 'center' | 'right'
  contentAlign: 'left' | 'center' | 'right'
}

export interface ImageNodeDefaults {
  width: number
  height: number
  fontSize: number
  titleAlign: 'left' | 'center' | 'right'
  collapsedTitleAlign: 'left' | 'center' | 'right'
}

export interface NodeDefaults {
  textNode: TextNodeDefaults
  imageNode: ImageNodeDefaults
}

// Default node defaults shared across frontend and backend
export const SHARED_NODE_DEFAULTS = {
  textNode: {
    width: 200,
    height: 120,
    color: '#ffffff',
    fontSize: 14,
    titleAlign: 'left' as const,
    collapsedTitleAlign: 'left' as const,
    contentAlign: 'left' as const,
  },
  imageNode: {
    width: 200,
    height: 150,
    fontSize: 14,
    titleAlign: 'left' as const,
    collapsedTitleAlign: 'left' as const,
  },
} as const satisfies NodeDefaults

// Validation constants
export const NODE_DEFAULTS_VALIDATION = {
  textNode: {
    minWidth: 100,
    maxWidth: 1000,
    minHeight: 60,
    maxHeight: 1000,
    minFontSize: 10,
    maxFontSize: 36,
  },
  imageNode: {
    minWidth: 100,
    maxWidth: 1000,
    minHeight: 60,
    maxHeight: 1000,
    minFontSize: 10,
    maxFontSize: 36,
  },
} as const
