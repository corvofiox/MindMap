import { useState, useEffect } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { NODE_COLORS, Z_INDEX, DEFAULT_NODE_DEFAULTS } from '@/constants'
import type { NodeDefaults, TextNodeDefaults, ImageNodeDefaults } from '@/types'
import { X, Loader2 } from 'lucide-react'

export function NodeDefaultsDialog() {
  const { nodeDefaultsOpen, setNodeDefaultsOpen, nodeDefaults, setNodeDefaults, saveNodeDefaults, resetNodeDefaults, addSuccessToast, addErrorToast } = useUIStore()
  const [activeTab, setActiveTab] = useState<'text' | 'image'>('text')
  const [tempDefaults, setTempDefaults] = useState<NodeDefaults>(DEFAULT_NODE_DEFAULTS)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (nodeDefaults && nodeDefaults.textNode && nodeDefaults.imageNode) {
      setTempDefaults(nodeDefaults)
    }
  }, [nodeDefaults])

  if (!nodeDefaultsOpen) return null

  const handleClose = () => setNodeDefaultsOpen(false)

  const handleUpdateText = (updates: Partial<TextNodeDefaults>) => {
    setTempDefaults((prev) => ({
      ...prev,
      textNode: { ...prev.textNode, ...updates },
    }))
  }

  const handleUpdateImage = (updates: Partial<ImageNodeDefaults>) => {
    setTempDefaults((prev) => ({
      ...prev,
      imageNode: { ...prev.imageNode, ...updates },
    }))
  }

  const handleSave = async () => {
    // 先更新本地状态和关闭对话框
    setIsSaving(true)
    setNodeDefaults(tempDefaults as unknown as Parameters<typeof setNodeDefaults>[0])
    setNodeDefaultsOpen(false)

    // 后台异步保存
    try {
      await saveNodeDefaults()
      addSuccessToast('节点默认设置已保存')
    } catch {
      addErrorToast('保存节点默认设置失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    resetNodeDefaults()
    setNodeDefaultsOpen(false)
  }

  const currentDefaults = activeTab === 'text' ? tempDefaults.textNode : tempDefaults.imageNode
  const handleUpdate = activeTab === 'text' ? handleUpdateText : handleUpdateImage

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: Z_INDEX.DIALOG }}
      onClick={handleClose}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            节点设置
          </h2>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 dark:border-gray-700">
          <div className="flex">
            <button
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'text'
                  ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
              onClick={() => setActiveTab('text')}
            >
              文本节点
            </button>
            <button
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'image'
                  ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
              onClick={() => setActiveTab('image')}
            >
              图片节点
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
          {activeTab === 'text' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                背景颜色
              </label>
              <div className="grid grid-cols-7 gap-2">
                {NODE_COLORS.map((color) => (
                  <button
                    key={color}
                    className={`w-10 h-10 rounded-lg border-2 transition-all ${
                      tempDefaults.textNode.color === color
                        ? 'border-blue-500 scale-110'
                        : 'border-gray-300 dark:border-gray-600 hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => handleUpdateText({ color })}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="color"
                  value={tempDefaults.textNode.color}
                  onChange={(e) => handleUpdateText({ color: e.target.value })}
                  className="w-10 h-10 rounded cursor-pointer"
                />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  自定义颜色
                </span>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              标题对齐
            </label>
            <div className="flex gap-2">
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.titleAlign === 'left'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ titleAlign: 'left' })}
              >
                左对齐
              </button>
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.titleAlign === 'center'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ titleAlign: 'center' })}
              >
                居中
              </button>
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.titleAlign === 'right'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ titleAlign: 'right' })}
              >
                右对齐
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              折叠状态标题对齐
            </label>
            <div className="flex gap-2">
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.collapsedTitleAlign === 'left'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ collapsedTitleAlign: 'left' })}
              >
                左对齐
              </button>
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.collapsedTitleAlign === 'center'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ collapsedTitleAlign: 'center' })}
              >
                居中
              </button>
              <button
                className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                  currentDefaults.collapsedTitleAlign === 'right'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}
                onClick={() => handleUpdate({ collapsedTitleAlign: 'right' })}
              >
                右对齐
              </button>
            </div>
          </div>

          {activeTab === 'text' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                内容对齐
              </label>
              <div className="flex gap-2">
                <button
                  className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                    tempDefaults.textNode.contentAlign === 'left'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}
                  onClick={() => handleUpdateText({ contentAlign: 'left' })}
                >
                  左对齐
                </button>
                <button
                  className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                    tempDefaults.textNode.contentAlign === 'center'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}
                  onClick={() => handleUpdateText({ contentAlign: 'center' })}
                >
                  居中
                </button>
                <button
                  className={`flex-1 py-2 px-3 rounded-lg border border-gray-300 dark:border-gray-600 transition-colors ${
                    tempDefaults.textNode.contentAlign === 'right'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}
                  onClick={() => handleUpdateText({ contentAlign: 'right' })}
                >
                  右对齐
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              字体大小
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="10"
                max="36"
                value={currentDefaults.fontSize}
                onChange={(e) => handleUpdate({ fontSize: parseInt(e.target.value) })}
                className="flex-1"
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-12 text-center">
                {currentDefaults.fontSize}px
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              尺寸
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">宽度</label>
                <input
                  type="number"
                  min="100"
                  max="1000"
                  value={currentDefaults.width}
                  onChange={(e) => handleUpdate({ width: parseInt(e.target.value) || 100 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">高度</label>
                <input
                  type="number"
                  min="60"
                  max="1000"
                  value={currentDefaults.height}
                  onChange={(e) => handleUpdate({ height: parseInt(e.target.value) || 60 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-between">
          <button
            onClick={handleReset}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors"
          >
            重置为默认
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isSaving ? '保存中...' : '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
