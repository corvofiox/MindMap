/**
 * 顶栏的信息架构约束：
 *   - 左右侧栏开关那一组里，只允许放这两个开关（笔记本入口不许夹在中间）；
 *   - 项目页的笔记本入口放在右上角"设置 / 账号"那一组的左侧；
 *   - 画布页不显示笔记本入口（那里只留左右栏开关与工具）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { useAuthStore } from '@/store/useAuthStore'
import { useUIStore } from '@/store/useUIStore'

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderHeader(path = '/projects') {
  return render(
    <MemoryRouter initialEntries={[path]}>
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
  it('左右侧栏开关那一组里没有笔记本入口', () => {
    renderHeader()

    const sidebarToggle = screen.getByTitle('切换侧边栏 (Ctrl+B)')
    const toggleGroup = sidebarToggle.parentElement as HTMLElement
    expect(within(toggleGroup).getByTitle('切换节点池 (Ctrl+P)')).toBeTruthy()
    expect(within(toggleGroup).queryByText('笔记本')).toBeNull()
  })

  it('项目页：笔记本入口是右上角那一批按钮里最左边的一个', () => {
    renderHeader('/projects')

    const notebook = screen.getByLabelText('打开笔记本')
    const search = screen.getByTitle('搜索节点 (Ctrl+F)')
    const settings = screen.getByTitle('设置 (Ctrl+,)')

    // 排在这批按钮的最左侧：在搜索之前，自然也在设置之前
    expect(notebook.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notebook.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // 与设置、账号同在顶栏右半部分
    const header = document.querySelector('header') as HTMLElement
    expect(within(header).getByLabelText('打开笔记本')).toBeTruthy()
    expect(within(header).getByLabelText('账号菜单')).toBeTruthy()

    // 笔记本与其余工具之间有一条分隔线：笔记本 → 分隔 → 搜索
    const separator = within(header).getByRole('separator')
    expect(notebook.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('进入项目（画布页）后，笔记本入口仍在那一批里', () => {
    renderHeader('/canvas/1')

    const notebook = screen.getByLabelText('打开笔记本')
    const search = screen.getByTitle('搜索节点 (Ctrl+F)')
    expect(notebook.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('账号菜单里不再重复放笔记本入口', () => {
    renderHeader('/projects')

    fireEvent.click(screen.getByLabelText('账号菜单'))

    // 顶栏那个「笔记本」按钮还在（唯一的），菜单里只留账号设置与退出登录
    expect(screen.getAllByText('笔记本')).toHaveLength(1)
    expect(screen.getByText('账号设置')).toBeTruthy()
    expect(screen.getByText('退出登录')).toBeTruthy()
  })

  it('账号菜单与笔记本页那一套一致：账号设置 / 退出登录，不拿昵称当菜单项', () => {
    renderHeader('/projects')

    fireEvent.click(screen.getByLabelText('账号菜单'))

    fireEvent.click(screen.getByText('账号设置'))
    expect(useUIStore.getState().accountSettingsOpen).toBe(true)
    // 昵称不再被塞进菜单项（头像上已有首字母）
    expect(screen.queryByText('测试同学')).toBeNull()
  })
})

describe('品牌图标', () => {
  it('点击左上角 MindMap 回到项目入口，而不是笔记本', () => {
    renderHeader('/canvas/1')

    fireEvent.click(screen.getByRole('button', { name: 'MindMap' }))

    expect(screen.getByTestId('location').textContent).toBe('/projects')
  })
})