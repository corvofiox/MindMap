import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { CommandPalette, SAVE_COMMAND_EVENT } from '../CommandPalette'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { exportCanvas, downloadJsonFile } from '@/utils/canvasExport'
import type { Project } from '@/types'

// createCanvas 走真实 store 逻辑(乐观更新+替换),仅 mock 网络层
vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createCanvas: vi.fn().mockResolvedValue({
      id: 100,
      name: '未命名画布 1',
      projectId: 1,
      folderId: null,
      thumbnail: null,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  }
})

vi.mock('@/utils/canvasExport', () => ({
  exportCanvas: vi.fn(() => '{}'),
  downloadJsonFile: vi.fn(),
}))

const mockProject: Project = {
  id: 1,
  name: 'P',
  description: null,
  ownerId: 1,
  groupId: null,
  thumbnail: null,
  isPublic: false,
  isCollaborative: false,
  createdAt: '',
  updatedAt: '',
  memberRole: 'owner',
}

function openPalette() {
  useUIStore.setState({ commandPaletteOpen: true })
  render(<CommandPalette />)
}

describe('CommandPalette 命令真实 action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ commandPaletteOpen: false, settingsOpen: false, gridVisible: true })
    // canvasId=1 模拟画布上下文(CanvasPage 挂载时 setCanvasId 写入)
    useCanvasStore.setState({ canvasId: 1, zoom: 1, panX: 0, panY: 0, selectedIds: [] })
    useProjectsStore.setState({ projects: [], canvases: [], currentProject: null, currentProjectId: null })
  })

  afterEach(() => {
    // 先卸载组件再重置 store,避免组件挂载期 uSES 订阅在 act 外 setState 产生警告
    cleanup()
    useUIStore.setState({ commandPaletteOpen: false, settingsOpen: false })
  })

  it('Toggle Grid 命令翻转 gridVisible 状态', () => {
    expect(useUIStore.getState().gridVisible).toBe(true)
    openPalette()
    fireEvent.click(screen.getByText('Toggle Grid'))
    expect(useUIStore.getState().gridVisible).toBe(false)
  })

  it('Zoom In 命令放大画布', () => {
    useCanvasStore.setState({ zoom: 1, panX: 50, panY: 50 })
    openPalette()
    fireEvent.click(screen.getByText('Zoom In'))
    expect(useCanvasStore.getState().zoom).toBeCloseTo(1.1)
  })

  it('Zoom Out 命令缩小画布', () => {
    useCanvasStore.setState({ zoom: 1, panX: 50, panY: 50 })
    openPalette()
    fireEvent.click(screen.getByText('Zoom Out'))
    expect(useCanvasStore.getState().zoom).toBeCloseTo(0.9)
  })

  it('Reset View 命令复位缩放与平移(原点居中)', () => {
    useCanvasStore.setState({ zoom: 2, panX: 50, panY: 50 })
    openPalette()
    fireEvent.click(screen.getByText('Reset View'))
    const state = useCanvasStore.getState()
    expect(state.zoom).toBe(1)
    // jsdom 无 [data-canvas-container],回退 window 尺寸 → 画布原点居中
    expect(state.panX).toBe(window.innerWidth / 2)
    expect(state.panY).toBe(window.innerHeight / 2)
  })

  it('Settings 命令打开设置对话框', () => {
    openPalette()
    fireEvent.click(screen.getByText('Settings'))
    expect(useUIStore.getState().settingsOpen).toBe(true)
  })

  it('New Canvas 命令触发 useProjectsStore 创建画布(乐观更新落地)', async () => {
    useProjectsStore.setState({ currentProject: mockProject, currentProjectId: 1 })
    openPalette()
    fireEvent.click(screen.getByText('New Canvas'))

    // 乐观更新:临时画布立即进入 canvases
    expect(useProjectsStore.getState().canvases.length).toBe(1)
    // 刷新微任务后,临时画布被 API 返回的真实画布替换
    await act(async () => {})
    expect(useProjectsStore.getState().canvases[0].id).toBe(100)
  })

  it('Save 命令派发保存桥接事件(CanvasPage 侧复用 Ctrl+S 逻辑)', () => {
    const listener = vi.fn()
    window.addEventListener(SAVE_COMMAND_EVENT, listener)
    openPalette()
    fireEvent.click(screen.getByText('Save'))
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(SAVE_COMMAND_EVENT, listener)
  })

  it('Export 命令导出画布 JSON 并下载', () => {
    useCanvasStore.setState({ zoom: 2, panX: 10, panY: 20, nodes: new Map() })
    openPalette()
    fireEvent.click(screen.getByText('Export'))
    expect(exportCanvas).toHaveBeenCalledWith(
      expect.any(Map),
      expect.any(Map),
      expect.any(Map),
      expect.any(Map),
      { zoom: 2, panX: 10, panY: 20 }
    )
    expect(downloadJsonFile).toHaveBeenCalledWith('{}', expect.stringMatching(/^mindmap-\d{4}-\d{2}-\d{2}\.json$/))
  })

  it('快捷键提示与实际快捷键一致(Toggle Grid 为 H,G 是分组工具)', () => {
    openPalette()
    // H 网格快捷键提示存在,裸 G(分组工具)不再出现在命令面板
    expect(screen.getByText('H')).toBeInTheDocument()
    expect(screen.queryByText('G')).toBeNull()
    // 其余命令保留与 CanvasPage 注册一致的快捷键提示
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+N')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+E')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+0')).toBeInTheDocument()
  })
})

describe('M-2 画布上下文守卫 / m-3 面板快捷键', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({
      commandPaletteOpen: false,
      settingsOpen: false,
      gridVisible: true,
      toasts: [],
    })
    // canvasId=null 模拟非画布页(项目列表/设置等)
    useCanvasStore.setState({ canvasId: null, zoom: 1, panX: 0, panY: 0, selectedIds: [] })
    useProjectsStore.setState({ projects: [], canvases: [], currentProject: null, currentProjectId: null })
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState({ commandPaletteOpen: false, settingsOpen: false })
  })

  it('非画布页:画布类命令灰置禁用,全局命令(New Canvas/Settings)保持可用', () => {
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    expect(screen.getByText('Save').closest('button')).toBeDisabled()
    expect(screen.getByText('Export').closest('button')).toBeDisabled()
    expect(screen.getByText('Zoom In').closest('button')).toBeDisabled()
    expect(screen.getByText('Zoom Out').closest('button')).toBeDisabled()
    expect(screen.getByText('Toggle Grid').closest('button')).toBeDisabled()
    expect(screen.getByText('Reset View').closest('button')).toBeDisabled()
    expect(screen.getByText('New Canvas').closest('button')).not.toBeDisabled()
    expect(screen.getByText('Settings').closest('button')).not.toBeDisabled()
  })

  it('非画布页:Enter 执行 Save 被拦截——不派发保存事件,给出"请先打开画布"提示', () => {
    const listener = vi.fn()
    window.addEventListener(SAVE_COMMAND_EVENT, listener)
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Type a command or search...')
    // selectedIndex 初始 0 = New Canvas(全局命令);ArrowDown 移到 Save
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(listener).not.toHaveBeenCalled()
    expect(
      useUIStore.getState().toasts.some((t) => t.type === 'warning' && t.title === '请先打开画布')
    ).toBe(true)
    window.removeEventListener(SAVE_COMMAND_EVENT, listener)
  })

  it('非画布页:Export 被拦截——不导出空 JSON,不弹成功 toast', () => {
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Type a command or search...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(exportCanvas).not.toHaveBeenCalled()
    expect(downloadJsonFile).not.toHaveBeenCalled()
    expect(
      useUIStore.getState().toasts.some((t) => t.type === 'success' && t.title === '导出成功')
    ).toBe(false)
  })

  it('m-3:面板打开时 Ctrl+S 直接执行保存(焦点在输入框也不被 typing guard 拦截)', () => {
    useCanvasStore.setState({ canvasId: 1 })
    const listener = vi.fn()
    window.addEventListener(SAVE_COMMAND_EVENT, listener)
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Type a command or search...')
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    expect(listener).toHaveBeenCalledTimes(1)
    // 与 Enter 执行后行为一致:执行完关闭面板
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
    window.removeEventListener(SAVE_COMMAND_EVENT, listener)
  })

  it('m-3:面板打开时 Ctrl+N 新建画布快捷键生效(乐观更新落地)', async () => {
    useCanvasStore.setState({ canvasId: 1 })
    useProjectsStore.setState({ currentProject: mockProject, currentProjectId: 1 })
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Type a command or search...')
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    // 乐观更新:临时画布立即进入 canvases
    expect(useProjectsStore.getState().canvases.length).toBe(1)
    await act(async () => {})
    expect(useProjectsStore.getState().canvases[0].id).toBe(100)
  })

  it('m-3:面板打开时再次 Ctrl+K 关闭面板', () => {
    useUIStore.setState({ commandPaletteOpen: true })
    render(<CommandPalette />)
    const input = screen.getByPlaceholderText('Type a command or search...')
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true })
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })
})
