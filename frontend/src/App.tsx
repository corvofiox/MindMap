import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from './store/useAuthStore'
import { useUIStore } from './store/useUIStore'
import { MainLayout } from './components/layout/MainLayout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { CanvasPage } from './pages/CanvasPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { DragGhost } from './components/DragGhost'
import { ToastContainer } from './components/ui/ToastContainer'

function ProtectedRoute() {
  const { isAuthenticated } = useAuthStore()
  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />
}

function App() {
  const { isAuthenticated, validateToken } = useAuthStore()
  const { initializeTheme, loadNodeDefaults } = useUIStore()
  const [isReady, setIsReady] = useState(false)

  // 初始化时验证 token，并在成功后加载节点默认配置
  useEffect(() => {
    const init = async () => {
      const isValid = await validateToken()
      // 只有在 token 验证成功后才加载节点默认配置
      if (isValid) {
        loadNodeDefaults()
      }
      // Mark as ready after token validation
      setIsReady(true)
    }
    init()
  }, [validateToken, loadNodeDefaults])

  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  // Show loading screen while initializing
  if (!isReady) {
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
