import { Z_INDEX } from '@/constants'
import type { CollabConnectionState } from '@/services/yjsProvider'

interface CollabConnectionBannerProps {
  /** 当前连接状态；为 `connected` 时不渲染任何内容。 */
  state: CollabConnectionState
}

/**
 * 常驻的协作连接状态提示条（画布底部居中）。
 *
 * 背景：断线此前只在"用户主动点保存"或被移出项目时才有提示，用户会在毫不知情的
 * 情况下继续编辑 —— 这就是静默断线。这里把状态常驻显示出来，并区分两种语义：
 *   - `reconnecting`（橙）：会自动重连，用户稍等即可，尽量避免刷新页面；
 *   - `stopped`（红）：重连已停止（被踢 / 服务端永久拒绝），需要用户处理。
 */
export function CollabConnectionBanner({ state }: CollabConnectionBannerProps) {
  if (state === 'connected') return null

  const reconnecting = state === 'reconnecting'

  return (
    <div
      data-collab-status={state}
      role="status"
      className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg shadow-lg text-sm font-medium border ${
        reconnecting
          ? 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/70 dark:text-amber-100 dark:border-amber-700'
          : 'bg-red-100 text-red-900 border-red-300 dark:bg-red-900/70 dark:text-red-100 dark:border-red-700'
      }`}
      style={{ zIndex: Z_INDEX.COLLAB_OVERLAY }}
    >
      {reconnecting ? '协作连接已断开，正在自动重连…' : '协作连接已断开，自动重连已停止'}
    </div>
  )
}
