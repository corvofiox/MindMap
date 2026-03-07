import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './store/useAuthStore'
import { useUIStore } from './store/useUIStore'
import { MainLayout } from './components/layout/MainLayout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { CanvasPage } from './pages/CanvasPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { DragGhost } from './components/DragGhost'
import { ToastContainer } from './components/ui/ToastContainer'
import { logger } from './utils/logger'

function ProtectedRoute() {
  const { isAuthenticated, isHydrated } = useAuthStore()
  
  logger.info('[App] ProtectedRoute check', { isAuthenticated, isHydrated })
  
  // Wait for hydration to complete before making routing decisions
  if (!isHydrated) {
    logger.info('[App] Not hydrated yet, returning null')
    return null // or a loading spinner
  }
  
  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />
}

function App() {
  const { isAuthenticated, isHydrated, validateToken } = useAuthStore()
  const { initializeTheme, loadNodeDefaults } = useUIStore()

  logger.info('[App] App render', { isAuthenticated, isHydrated })

  // 初始化时验证 token，并在成功后加载节点默认配置
  useEffect(() => {
    const init = async () => {
      logger.info('[App] Starting init, validating token')
      const isValid = await validateToken()
      logger.info('[App] Token validation result', { isValid })
      // 只有在 token 验证成功后才加载节点默认配置
      if (isValid) {
        loadNodeDefaults()
      }
    }
    init()
  }, [validateToken, loadNodeDefaults])

  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  // Wait for hydration to complete before making routing decisions
  if (!isHydrated) {
    logger.info('[App] Not hydrated, showing loading screen')
    return (
      <>
        <DragGhost />
        <ToastContainer />
        <div className="h-screen w-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-gray-300 border-t-blue-500 mb-3" />
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">加载中...</p>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <DragGhost />
      <ToastContainer />
      <Routes>
        <Route path="/login" element={!isAuthenticated ? <LoginPage /> : <Navigate to="/projects" />} />
        <Route path="/register" element={!isAuthenticated ? <RegisterPage /> : <Navigate to="/projects" />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route element={<ProtectedRoute />}>
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="canvas/:canvasId" element={<CanvasPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to={isAuthenticated ? "/projects" : "/login"} replace />} />
      </Routes>
    </>
  )
}

export default App
