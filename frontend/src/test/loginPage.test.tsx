/**
 * 登录页的落点：主页面是项目列表，所以登录成功去 /projects（不是笔记本）。
 *
 * 这里只把 auth store 换成一个可编程的桩（它就是页面与应用状态之间的边界），
 * 页面本身、路由与跳转都是真的。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const mocks = vi.hoisted(() => ({
  login: vi.fn<(credentials: { email: string; password: string }) => Promise<void>>(),
  addToast: vi.fn<(toast: { type: string; title: string; message: string }) => void>(),
}))

vi.mock('@/store/useAuthStore', () => ({
  useAuthStore: () => ({ login: mocks.login }),
}))

vi.mock('@/store/useUIStore', () => ({
  useUIStore: () => ({ addToast: mocks.addToast }),
}))

const { LoginPage } = await import('@/pages/LoginPage')

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/projects" element={<LocationProbe />} />
        <Route path="/notebook" element={<LocationProbe />} />
        <Route path="/register" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

function submit(email = 'tester@mindmap.local', password = 'Mindmap2026!') {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('登录', () => {
  it('登录成功落到项目列表 /projects', async () => {
    mocks.login.mockResolvedValueOnce(undefined)
    renderLogin()
    submit()

    expect((await screen.findByTestId('location')).textContent).toBe('/projects')
    expect(mocks.login).toHaveBeenCalledWith({ email: 'tester@mindmap.local', password: 'Mindmap2026!' })
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('登录失败留在登录页，并提示失败原因', async () => {
    mocks.login.mockRejectedValueOnce(new Error('邮箱或密码不正确'))
    renderLogin()
    submit('tester@mindmap.local', 'wrong-password')

    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: '邮箱或密码不正确' }),
      ),
    )
    // 没有跳到任何页面：登录表单还在
    expect(screen.queryByTestId('location')).toBeNull()
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
  })

  it('提交过程中按钮禁用并显示"登录中..."，避免重复提交', async () => {
    let resolveLogin: () => void = () => {}
    mocks.login.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveLogin = resolve }),
    )
    renderLogin()
    submit()

    const pending = await screen.findByRole('button', { name: '登录中...' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)

    resolveLogin()
    await screen.findByTestId('location')
  })

  it('底部「注册」链接指向注册页', () => {
    renderLogin()
    fireEvent.click(screen.getByText('注册'))
    expect(screen.getByTestId('location').textContent).toBe('/register')
  })
})
