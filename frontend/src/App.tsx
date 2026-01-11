import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './store/useAuthStore'
import { MainLayout } from './components/layout/MainLayout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { CanvasPage } from './pages/CanvasPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { DragGhost } from './components/DragGhost'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore()
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

function App() {
  const { isAuthenticated, validateToken } = useAuthStore()

  useEffect(() => {
    validateToken()
  }, [validateToken])

  return (
    <>
      <DragGhost />
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
