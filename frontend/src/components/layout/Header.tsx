import { useNavigate } from 'react-router-dom'
import { Users, Settings, LogOut, User as UserIcon } from 'lucide-react'
import { useAuthStore } from '@/store/useAuthStore'
import { useUIStore } from '@/store/useUIStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { DropdownMenu } from '../ui/DropdownMenu'

export function Header() {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()
  const { toggleSidebar, toggleNodePool } = useUIStore()
  const { currentProject } = useProjectsStore()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <header className="h-14 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center justify-between px-4">
      {/* Left - Logo and Project */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/projects')}
          className="text-xl font-bold text-gray-800 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          MindMap
        </button>

        {currentProject && (
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
        )}

        {currentProject && (
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {currentProject.name}
          </span>
        )}
      </div>

      {/* Center - Tools */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          title="切换侧边栏 (Ctrl+B)"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <button
          onClick={toggleNodePool}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          title="切换节点池 (Ctrl+P)"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </button>
      </div>

      {/* Right - User and Settings */}
      <div className="flex items-center gap-2">
        {/* Settings */}
        <DropdownMenu
          trigger={
            <button
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
              title="设置 (Ctrl+,)"
            >
              <Settings className="w-5 h-5" />
            </button>
          }
          items={[
            { label: '应用设置', action: () => useUIStore.getState().setSettingsOpen(true) },
            { label: '快捷键', action: () => useUIStore.getState().setShortcutsOpen(true) },
          ]}
        />

        {/* User Avatar Dropdown */}
        <DropdownMenu
          trigger={
            <button className="flex items-center gap-2 ml-2">
              {user?.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.nickname || user.email}
                  className="w-8 h-8 rounded-full object-cover hover:ring-2 hover:ring-blue-500 transition-all"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white font-medium hover:ring-2 hover:ring-blue-500 transition-all">
                  {(user?.nickname || user?.email || 'U').charAt(0).toUpperCase()}
                </div>
              )}
            </button>
          }
          items={[
            { label: user?.nickname || user?.email || '用户', action: () => useUIStore.getState().setAccountSettingsOpen(true), icon: UserIcon },
            { divider: true },
            { label: '退出登录', action: handleLogout, icon: LogOut },
          ]}
        />
      </div>
    </header>
  )
}
