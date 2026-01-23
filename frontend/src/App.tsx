import { Routes, Route, Navigate } from 'react-router-dom'
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore()
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

function App() {
  const { isAuthenticated, validateToken } = useAuthStore()
  const { initializeTheme, loadNodeDefaults } = useUIStore()

  // 初始化时验证 token，并在成功后加载节点默认配置
  useEffect(() => {
    const init = async () => {
      const isValid = await validateToken()
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

  return (
    <>
      <DragGhost />
      <ToastContainer />
      <Routes>
        <Route path="/login" element={!isAuthenticated ? <LoginPage /> : <Navigate to="/projects" />} />
        <Route path="/register" element={!isAuthenticated ? <RegisterPage /> : <Navigate to="/projects" />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={
            <ProtectedRoute>
              <ProjectsPage />
            </ProtectedRoute>
          } />
          <Route path="canvas/:canvasId" element={
            <ProtectedRoute>
              <CanvasPage />
            </ProtectedRoute>
          } />
        </Route>
        <Route path="*" element={<Navigate to={isAuthenticated ? "/projects" : "/login"} replace />} />
      </Routes>
    </>
  )
}

export default App
