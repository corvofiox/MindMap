import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, User, Key, Trash2, Camera, Loader2 } from 'lucide-react'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { changePassword, deleteAccount, uploadImage } from '@/services/api'
import { Z_INDEX } from '@/constants'

interface Tab {
  id: 'profile' | 'security' | 'danger'
  label: string
  icon: React.ElementType
}

const tabs: Tab[] = [
  { id: 'profile', label: '个人资料', icon: User },
  { id: 'security', label: '安全设置', icon: Key },
  { id: 'danger', label: '危险区域', icon: Trash2 },
]

export function AccountSettingsDialog() {
  const navigate = useNavigate()
  const { accountSettingsOpen, setAccountSettingsOpen, addToast } = useUIStore()
  const { user, updateProfile, logout } = useAuthStore()

  const [activeTab, setActiveTab] = useState<Tab['id']>('profile')
  const [loading, setLoading] = useState(false)

  // Profile state
  const [nickname, setNickname] = useState(user?.nickname || '')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)

  // Password state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Delete account state
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')

  if (!accountSettingsOpen) return null

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setAvatarFile(file)
      setAvatarPreview(URL.createObjectURL(file))
    }
  }

  const handleSaveProfile = async () => {
    setLoading(true)
    try {
      let avatarUrl = user?.avatar || null

      if (avatarFile) {
        const uploadResult = await uploadImage(avatarFile)
        avatarUrl = uploadResult.url
      }

      await updateProfile({
        nickname: nickname || null,
        avatar: avatarUrl,
      })

      addToast({
        type: 'success',
        title: '保存成功',
        message: '个人资料已更新',
      })
      setAvatarFile(null)
      setAvatarPreview(null)
    } catch (error) {
      addToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      addToast({
        type: 'error',
        title: '密码不匹配',
        message: '新密码和确认密码不一致',
      })
      return
    }

    if (newPassword.length < 6) {
      addToast({
        type: 'error',
        title: '密码太短',
        message: '新密码至少需要 6 个字符',
      })
      return
    }

    setLoading(true)
    try {
      await changePassword({
        currentPassword,
        newPassword,
      })

      addToast({
        type: 'success',
        title: '密码已更新',
        message: '您的密码已成功更改',
      })

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      addToast({
        type: 'error',
        title: '密码修改失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmation !== 'DELETE') {
      addToast({
        type: 'error',
        title: '确认失败',
        message: '请输入 DELETE 以确认删除',
      })
      return
    }

    setLoading(true)
    try {
      await deleteAccount({
        password: deletePassword,
        confirmation: deleteConfirmation,
      })

      addToast({
        type: 'success',
        title: '账号已删除',
        message: '您的账号已被永久删除',
      })

      await logout()
      try {
        localStorage.removeItem('mindmap_token')
      } catch {
        // Storage may be unavailable; logout already cleared in-memory state.
      }
      navigate('/login')
    } catch (error) {
      addToast({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setLoading(false)
    }
  }

  const activeTabConfig = tabs.find((t) => t.id === activeTab)
  const ActiveIcon = activeTabConfig?.icon || User

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: Z_INDEX.DIALOG }}
      onClick={() => setAccountSettingsOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <ActiveIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              账户设置
            </h2>
          </div>

          <button
            onClick={() => setAccountSettingsOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-48 border-r border-gray-200 dark:border-gray-700 p-4">
            <nav className="space-y-1">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`
                      w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
                      ${activeTab === tab.id
                        ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }
                    `}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </button>
                )
              })}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 p-6 overflow-y-auto">
            {activeTab === 'profile' && (
              <div className="space-y-6">
                {/* Avatar */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    头像
                  </label>
                  <div className="flex items-center gap-4">
                    <div className="w-20 h-20 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                      {avatarPreview || user?.avatar ? (
                        <img
                          src={avatarPreview || user?.avatar || undefined}
                          alt="Avatar preview"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-2xl text-gray-400">
                          {(user?.nickname || user?.email || 'U').charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div>
                      <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors">
                        <Camera className="w-4 h-4" />
                        更换头像
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleAvatarChange}
                          className="hidden"
                        />
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        支持 JPG、PNG 格式
                      </p>
                    </div>
                  </div>
                </div>

                {/* Nickname */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    昵称
                  </label>
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                    placeholder="输入昵称"
                  />
                </div>

                {/* Email (readonly) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    邮箱
                  </label>
                  <input
                    type="email"
                    value={user?.email || ''}
                    readOnly
                    className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-500 dark:text-gray-400 cursor-not-allowed"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    邮箱地址不可修改
                  </p>
                </div>

                {/* Save button */}
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveProfile}
                    disabled={loading}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    保存更改
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
                    修改密码
                  </h3>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        当前密码
                      </label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                        placeholder="输入当前密码"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        新密码
                      </label>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                        placeholder="输入新密码 (至少 6 个字符)"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        确认新密码
                      </label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                        placeholder="再次输入新密码"
                      />
                    </div>

                    <div className="flex justify-end">
                      <button
                        onClick={handleChangePassword}
                        disabled={loading || !currentPassword || !newPassword || !confirmPassword}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                      >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                        更新密码
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'danger' && (
              <div className="space-y-6">
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <h3 className="text-lg font-medium text-red-900 dark:text-red-100 mb-2">
                    删除账号
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-300 mb-4">
                    删除账号是不可逆的操作。此操作将永久删除您的账号以及所有相关数据：
                  </p>
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1 mb-4 list-disc list-inside">
                    <li>您的个人资料</li>
                    <li>您拥有的所有项目</li>
                    <li>您创建的所有画布</li>
                    <li>您上传的所有文件</li>
                    <li>您在节点池中的所有卡片</li>
                  </ul>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      确认密码
                    </label>
                    <input
                      type="password"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                      placeholder="输入您的密码以确认删除"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      输入 DELETE 确认
                    </label>
                    <input
                      type="text"
                      value={deleteConfirmation}
                      onChange={(e) => setDeleteConfirmation(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                      placeholder="输入 DELETE"
                    />
                  </div>

                  <button
                    onClick={handleDeleteAccount}
                    disabled={loading || !deletePassword || deleteConfirmation !== 'DELETE'}
                    className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    永久删除账号
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
