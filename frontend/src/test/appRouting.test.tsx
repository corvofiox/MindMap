/**
 * 应用落点约束：主页面是「项目列表」。
 *
 *   - 打开根路径 `/` 并且已登录 → /projects（不是 /notebook）
 *   - 未登录访问 `/` → /login
 *   - 已登录还去 /login /register → 回 /projects
 *   - 不认识的地址 → /projects（未登录则 /login）
 *   - /notebook 仍然是一个可以直接访问的独立页面
 *
 * 这里直接渲染真实的 App（含真实路由表），只把各个页面与布局替换成探针组件，
 * 避免把画布、Yjs、dnd 等重量级依赖拖进单测。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Outlet } from 'react-router-dom'

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false },
}))

vi.mock('@/store/useAuthStore', () => ({
  useAuthStore: () => ({
    isAuthenticated: mocks.auth.isAuthenticated,
    validateToken: async () => mocks.auth.isAuthenticated,
  }),
}))

vi.mock('@/store/useUIStore', () => ({
  useUIStore: () => ({
    initializeTheme: () => undefined,
    loadNodeDefaults: () => undefined,
  }),
}))

vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: () => (
    <div data-testid="layout-main">
      <Outlet />
    </div>
  ),
}))

vi.mock('@/pages/ProjectsPage', () => ({
  ProjectsPage: () => <div data-testid="page-projects" />,
}))
vi.mock('@/pages/CanvasPage', () => ({
  CanvasPage: () => <div data-testid="page-canvas" />,
}))
vi.mock('@/pages/NotebookPage', () => ({
  NotebookPage: () => <div data-testid="page-notebook" />,
}))
vi.mock('@/pages/LoginPage', () => ({
  LoginPage: () => <div data-testid="page-login" />,
}))
vi.mock('@/pages/RegisterPage', () => ({
  RegisterPage: () => <div data-testid="page-register" />,
}))
vi.mock('@/components/DragGhost', () => ({ DragGhost: () => null }))
vi.mock('@/components/ui/ToastContainer', () => ({ ToastContainer: () => null }))

import App from '@/App'

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
  // App 会先做一次 token 校验（异步），校验完才渲染路由表
  await screen.findByTestId(/^page-/)
}

beforeEach(() => {
  cleanup()
  mocks.auth.isAuthenticated = false
})

describe('应用首页落点', () => {
  it('已登录访问根路径，落到项目列表', async () => {
    mocks.auth.isAuthenticated = true
    await renderAt('/')

    expect(screen.getByTestId('page-projects')).toBeTruthy()
    expect(screen.queryByTestId('page-notebook')).toBeNull()
  })

  it('已登录访问根路径时，项目列表套在主导航布局里（有顶栏与侧栏）', async () => {
    mocks.auth.isAuthenticated = true
    await renderAt('/')

    const layout = screen.getByTestId('layout-main')
    expect(layout.contains(screen.getByTestId('page-projects'))).toBe(true)
  })

  it('未登录访问根路径，先去登录页', async () => {
    mocks.auth.isAuthenticated = false
    await renderAt('/')

    expect(screen.getByTestId('page-login')).toBeTruthy()
    expect(screen.queryByTestId('page-projects')).toBeNull()
  })

  it('已登录再去登录页/注册页，都被送回项目列表', async () => {
    mocks.auth.isAuthenticated = true

    await renderAt('/login')
    expect(screen.getByTestId('page-projects')).toBeTruthy()
    cleanup()

    await renderAt('/register')
    expect(screen.getByTestId('page-projects')).toBeTruthy()
  })

  it('不认识的地址落到项目列表；未登录则落到登录页', async () => {
    mocks.auth.isAuthenticated = true
    await renderAt('/no-such-page')
    expect(screen.getByTestId('page-projects')).toBeTruthy()
    cleanup()

    mocks.auth.isAuthenticated = false
    await renderAt('/no-such-page')
    expect(screen.getByTestId('page-login')).toBeTruthy()
  })

  it('笔记本仍是可直达的独立页面（不在主导航布局里）', async () => {
    mocks.auth.isAuthenticated = true
    await renderAt('/notebook/1')

    expect(screen.getByTestId('page-notebook')).toBeTruthy()
    expect(screen.queryByTestId('layout-main')).toBeNull()
  })

  it('画布地址仍由主导航布局承载', async () => {
    mocks.auth.isAuthenticated = true
    await renderAt('/canvas/6')

    expect(screen.getByTestId('page-canvas')).toBeTruthy()
    expect(screen.getByTestId('layout-main')).toBeTruthy()
  })
})
