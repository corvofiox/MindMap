// API endpoints
export const API_ENDPOINTS = {
  // Auth
  AUTH_REGISTER: '/api/auth/register',
  AUTH_LOGIN: '/api/auth/login',
  AUTH_LOGOUT: '/api/auth/logout',
  AUTH_REFRESH: '/api/auth/refresh',
  AUTH_FORGOT_PASSWORD: '/api/auth/forgot-password',
  AUTH_RESET_PASSWORD: '/api/auth/reset-password',

  // User
  USER_PROFILE: '/api/users/profile',
  USER_AVATAR: '/api/users/avatar',
  USER_PASSWORD: '/api/users/password',
  USER_DELETE_ACCOUNT: '/api/users/account',
  UPLOAD: '/api/upload',

  // Projects
  PROJECTS: '/api/projects',
  PROJECT_BY_ID: (id: number) => `/api/projects/${id}`,
  PROJECT_MEMBERS: (id: number) => `/api/projects/${id}/members`,
  PROJECT_MEMBER_REMOVE: (id: number, userId: number) =>
    `/api/projects/${id}/members/${userId}`,

  // Canvases
  CANVASES: (projectId: number) => `/api/canvases/${projectId}`,
  CANVAS_BY_ID: (id: number) => `/api/canvases/${id}`,
  CANVAS_DETAIL: (id: number) => `/api/canvases/detail/${id}`,
  CANVAS_RESTORE: (id: number) => `/api/canvases/${id}/restore`,

  // Node Pool
  NODE_POOL: (projectId: number) => `/api/projects/${projectId}/node-pool`,
  NODE_POOL_DELETE: (id: number) => `/api/projects/node-pool/${id}`,
  NODE_POOL_UPDATE: (id: number) => `/api/projects/node-pool/${id}`,
} as const

// WebSocket configuration
export const WS_CONFIG = {
  // 自动根据当前页面URL构建WebSocket URL
  get URL(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws`;
  },
  PATH: '/ws',
  RECONNECT_INTERVAL: 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
} as const

// Canvas defaults
export const CANVAS_DEFAULTS = {
  GRID_SIZE: 20,
  GRID_DOT_SIZE: 1,
  DEFAULT_ZOOM: 1,
  MIN_ZOOM: 0.1,
  MAX_ZOOM: 5,
  ZOOM_STEP: 0.1,
} as const

// Node defaults
export const NODE_DEFAULTS = {
  WIDTH: 200,
  HEIGHT: 120,
  MIN_WIDTH: 100,
  MIN_HEIGHT: 60,
  COLOR: '#ffffff',
  BORDER_COLOR: '#e5e7eb',
  BORDER_WIDTH: 1,
  BORDER_RADIUS: 8,
  FONT_SIZE: 14,
  TEXT_ALIGN: 'center' as const,
  PADDING: 16,
} as const

// Group defaults
export const GROUP_DEFAULTS = {
  BORDER_WIDTH: 2,
  BORDER_RADIUS: 8,
  BACKGROUND_COLOR: 'rgba(59, 130, 246, 0.1)',
  BORDER_COLOR: '#3b82f6',
} as const

// Domain defaults
export const DOMAIN_DEFAULTS = {
  BACKGROUND_COLOR: 'rgba(156, 163, 175, 0.2)',
  BORDER_COLOR: '#9ca3af',
  BORDER_WIDTH: 1,
} as const

// Connection defaults
export const CONNECTION_DEFAULTS = {
  COLOR: '#3b82f6',
  WIDTH: 2,
  TYPE: 'curve',
  STYLE: 'solid',
  ARROW_TYPE: 'end',
  BEND_POINT_RADIUS: 8,
  BEND_POINT_HIT_RADIUS: 12,
} as const

// Colors
export const NODE_COLORS = [
  '#ffffff',
  '#fef3c7',
  '#fce7f3',
  '#dbeafe',
  '#d1fae5',
  '#e0e7ff',
  '#fee2e2',
  '#f3e8ff',
] as const

export const BORDER_COLORS = [
  '#e5e7eb',
  '#fcd34d',
  '#f472b6',
  '#60a5fa',
  '#34d399',
  '#818cf8',
  '#f87171',
  '#a78bfa',
] as const

// Keyboard shortcuts
export const SHORTCUTS = {
  // Canvas
  CANVAS_ZOOM_IN: 'Ctrl+=',
  CANVAS_ZOOM_OUT: 'Ctrl+-',
  CANVAS_ZOOM_RESET: 'Ctrl+0',
  CANVAS_FIT: 'F',
  CANVAS_TOGGLE_GRID: 'G',

  // Node
  NODE_CREATE: 'N',
  NODE_DELETE: 'Delete',
  NODE_COPY: 'Ctrl+C',
  NODE_PASTE: 'Ctrl+V',
  NODE_CUT: 'Ctrl+X',
  NODE_DUPLICATE: 'Ctrl+D',
  NODE_EDIT: 'Enter',
  NODE_ESCAPE: 'Escape',

  // Group
  GROUP_CREATE: 'Ctrl+G',
  GROUP_UNGROUP: 'Ctrl+Shift+G',

  // Domain
  DOMAIN_MODE: 'R',

  // Connection
  CONNECTION_MODE: 'L',

  // Selection
  SELECT_ALL: 'Ctrl+A',
  SELECT_NONE: 'Ctrl+Shift+A',

  // File
  FILE_SAVE: 'Ctrl+S',
  FILE_EXPORT: 'Ctrl+E',
  FILE_NEW: 'Ctrl+N',
  FILE_CLOSE: 'Ctrl+W',

  // Search
  SEARCH: 'Ctrl+F',
  SEARCH_GLOBAL: 'Ctrl+Shift+F',

  // Panels
  PANEL_SIDEBAR: 'Ctrl+B',
  PANEL_NODE_POOL: 'Ctrl+P',
  PANEL_SETTINGS: 'Ctrl+,',
  PANEL_HELP: 'Ctrl+H',

  // Undo/Redo
  UNDO: 'Ctrl+Z',
  REDO: 'Ctrl+Y',

  // Tabs
  TAB_NEXT: 'Ctrl+Tab',
  TAB_PREV: 'Ctrl+Shift+Tab',
} as const

// Local storage keys
export const STORAGE_KEYS = {
  TOKEN: 'mindmap_token',
  THEME: 'mindmap_theme',
  SETTINGS: 'mindmap_settings',
  RECENT_CANVASES: 'mindmap_recent_canvases',
} as const

// Timeouts
export const TIMEOUTS = {
  TOAST: 3000,
  DEBOUNCE: 300,
  AUTOSAVE: 5000,
} as const
