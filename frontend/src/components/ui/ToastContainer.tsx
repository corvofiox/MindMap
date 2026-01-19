import { useUIStore } from '@/store/useUIStore'
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useEffect } from 'react'
import clsx from 'clsx'

export function ToastContainer() {
  const { toasts, removeToast } = useUIStore()

  return (
    <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function Toast({ toast, onRemove }: { toast: any; onRemove: () => void }) {
  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(onRemove, toast.duration || 3000)
      return () => clearTimeout(timer)
    }
  }, [toast.duration, onRemove])

  const icons = {
    success: CheckCircle,
    error: AlertCircle,
    warning: AlertTriangle,
    info: Info,
  }

  const colors = {
    success: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
    error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
    warning: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200',
    info: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200',
  }

  const Icon = icons[toast.type]

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg animate-in',
        colors[toast.type]
      )}
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />

      <div className="flex-1 min-w-0">
        <h4 className="font-medium text-sm">{toast.title}</h4>
        {toast.message && (
          <p className="text-sm mt-0.5 opacity-90">{toast.message}</p>
        )}
      </div>

      <button
        onClick={onRemove}
        className="flex-shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
