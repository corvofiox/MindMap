/**
 * 顶栏的信息架构约束：
 *   中间那一段只放"左侧栏 / 右侧栏"的开关，不允许塞别的工作区入口。
 *   笔记本入口挪到账号菜单 + 项目页按钮，这里一并钉住，避免有人又塞回去。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { useAuthStore } from '@/store/useAuthStore'

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderHeader() {
  return render(
    <MemoryRouter initialEntries={['/projects']}>
      <Header />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, email: 'tester@mindmap.local', nickname: '测试同学', avatar: null } as never,
  })
})

describe('顶栏', () => {
  it('只保留左右侧栏开关，没有笔记本入口', () => {
    renderHeader()

    expect(screen.getByTitle('切换侧边栏 (Ctrl+B)')).toBeTruthy()
    expect(screen.getByTitle('切换节点池 (Ctrl+P)')).toBeTruthy()
    expect(screen.queryByTitle('切换到笔记本')).toBeNull()

    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    expect(within(header as HTMLElement).queryByText('笔记本')).toBeNull()
  })

  it('笔记本入口在账号菜单里，点击后跳转 /notebook', () => {
    renderHeader()

    // 打开头像菜单
    fireEvent.click(screen.getByLabelText('账号菜单'))
    const item = screen.getByText('笔记本')
    fireEvent.click(item)

    expect(screen.getByTestId('location').textContent).toBe('/notebook')
  })
})
