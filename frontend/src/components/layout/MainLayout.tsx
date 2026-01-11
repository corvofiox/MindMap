import { Outlet } from 'react-router-dom'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { NodePoolPanel } from '@/features/node-pool/components/NodePoolPanel'
import { ToastContainer } from '../ui/ToastContainer'
import { CommandPalette } from '../ui/CommandPalette'
import { SettingsDialog } from '../ui/SettingsDialog'
import { AccountSettingsDialog } from '../ui/AccountSettingsDialog'
import { ShortcutsDialog } from '../ui/ShortcutsDialog'
import { SearchPanel } from '../ui/SearchPanel'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'

export function MainLayout() {
  const { sidebarOpen, nodePoolOpen } = useUIStore()
  const { isAuthenticated } = useAuthStore()

  if (!isAuthenticated) {
    return <Outlet />
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
      <Header />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left Sidebar */}
        <Sidebar open={sidebarOpen} />

        {/* Main Content */}
        <main className="flex-1 overflow-hidden min-h-0">
          <Outlet />
        </main>

        {/* Right Panel - Node Pool */}
        <NodePoolPanel open={nodePoolOpen} />
      </div>

      {/* Overlays */}
      <ToastContainer />
      <CommandPalette />
      <SettingsDialog />
      <AccountSettingsDialog />
      <ShortcutsDialog />
      <SearchPanel />
    </div>
  )
}
