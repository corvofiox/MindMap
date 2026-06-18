import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Users table
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  nickname: text('nickname'),
  avatar: text('avatar'),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
  updatedAt: integer('updated_at').default(sql`strftime('%s', 'now')`),
})

// Groups (Organization Groups)
export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  inviteCode: text('invite_code').notNull().unique(),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
})

// Group Members
export const groupMembers = sqliteTable('group_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupId: integer('group_id').notNull().references(() => groups.id),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role').notNull().default('member'), // owner, admin, member
  joinedAt: integer('joined_at').default(sql`strftime('%s', 'now')`),
})

// Projects
export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  groupId: integer('group_id').references(() => groups.id),
  thumbnail: text('thumbnail'),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  isCollaborative: integer('is_collaborative', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
  updatedAt: integer('updated_at').default(sql`strftime('%s', 'now')`),
})

// Project Members
export const projectMembers = sqliteTable('project_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role').notNull().default('viewer'), // owner, editor, viewer
  joinedAt: integer('joined_at').default(sql`strftime('%s', 'now')`),
})

// Project Invitations
export const projectInvitations = sqliteTable('project_invitations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  inviterId: integer('inviter_id').notNull().references(() => users.id),
  inviteeId: integer('invitee_id').notNull().references(() => users.id),
  role: text('role').notNull().default('viewer'), // editor, viewer
  status: text('status').notNull().default('pending'), // pending, accepted, rejected
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
  respondedAt: integer('responded_at'),
})

// Folders
export const folders = sqliteTable('folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  parentId: integer('parent_id').references(() => folders.id),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
})

// Canvases
export const canvases = sqliteTable('canvases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  folderId: integer('folder_id').references(() => folders.id),
  yjsData: text('yjs_data'), // Legacy: Canvas data as JSON base64 (pre-Yjs snapshot, kept for rollback)
  yjsUpdate: text('yjs_update'), // Yjs binary state update, base64 encoded (authoritative since Yjs migration)
  previewText: text('preview_text'),
  thumbnail: text('thumbnail'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
  updatedAt: integer('updated_at').default(sql`strftime('%s', 'now')`),
})

// Canvas Recycle Bin
export const canvasRecycleBin = sqliteTable('canvas_recycle_bin', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canvasId: integer('canvas_id').notNull().references(() => canvases.id),
  projectId: integer('project_id').notNull().references(() => projects.id),
  deletedBy: integer('deleted_by').notNull().references(() => users.id),
  deletedAt: integer('deleted_at').default(sql`strftime('%s', 'now')`),
  expiresAt: integer('expires_at').notNull(),
})

// Node Pool (Node Cards) - User-specific, independent of projects
export const nodeCards = sqliteTable('node_cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  content: text('content').notNull(), // JSON string
  type: text('type').notNull().default('text'),
  color: text('color').notNull().default('#ffffff'),
  tags: text('tags'), // Comma-separated
  useCount: integer('use_count').notNull().default(0),
  createdBy: integer('created_by').notNull().references(() => users.id),
  folderId: integer('folder_id').references(() => nodePoolFolders.id),
  description: text('description'),
  thumbnail: text('thumbnail'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
})

// Node Pool Folders - User-specific, independent of projects
export const nodePoolFolders = sqliteTable('node_pool_folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  parentId: integer('parent_id').references(() => nodePoolFolders.id),
  sortOrder: integer('sort_order').notNull().default(0),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
})

// Settings
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  key: text('key').notNull(),
  value: text('value').notNull(),
  category: text('category').notNull().default('general'),
})

// Files
export const files = sqliteTable('files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  path: text('path').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type').notNull(),
  uploaderId: integer('uploader_id').notNull().references(() => users.id),
  projectId: integer('project_id').references(() => projects.id),
  createdAt: integer('created_at').default(sql`strftime('%s', 'now')`),
})

// AI Chat Conversations - 画布级别的AI对话历史
export const aiConversations = sqliteTable('ai_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canvasId: integer('canvas_id').notNull().references(() => canvases.id),
  userId: integer('user_id').notNull().references(() => users.id),
  messages: text('messages').notNull(), // JSON string of messages array
  contextDividerIndex: integer('context_divider_index').notNull().default(-1),
  updatedAt: integer('updated_at').default(sql`strftime('%s', 'now')`),
})

// Type exports
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Group = typeof groups.$inferSelect
export type NewGroup = typeof groups.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type ProjectInvitation = typeof projectInvitations.$inferSelect
export type NewProjectInvitation = typeof projectInvitations.$inferInsert
export type Canvas = typeof canvases.$inferSelect
export type NewCanvas = typeof canvases.$inferInsert
export type Folder = typeof folders.$inferSelect
export type NewFolder = typeof folders.$inferInsert
export type NodeCard = typeof nodeCards.$inferSelect
export type NewNodeCard = typeof nodeCards.$inferInsert
export type NodePoolFolder = typeof nodePoolFolders.$inferSelect
export type NewNodePoolFolder = typeof nodePoolFolders.$inferInsert
export type File = typeof files.$inferSelect
export type NewFile = typeof files.$inferInsert
export type AIConversation = typeof aiConversations.$inferSelect
export type NewAIConversation = typeof aiConversations.$inferInsert
