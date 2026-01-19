import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const users = sqliteTable('users', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull().unique(),
    password: text('password').notNull(),
    nickname: text('nickname'),
    avatar: text('avatar'),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
    updatedAt: integer('updated_at').default(sql `strftime('%s', 'now')`),
});
export const groups = sqliteTable('groups', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: integer('owner_id').notNull().references(() => users.id),
    inviteCode: text('invite_code').notNull().unique(),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
});
export const groupMembers = sqliteTable('group_members', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id').notNull().references(() => groups.id),
    userId: integer('user_id').notNull().references(() => users.id),
    role: text('role').notNull().default('member'),
    joinedAt: integer('joined_at').default(sql `strftime('%s', 'now')`),
});
export const projects = sqliteTable('projects', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: integer('owner_id').notNull().references(() => users.id),
    groupId: integer('group_id').references(() => groups.id),
    thumbnail: text('thumbnail'),
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
    updatedAt: integer('updated_at').default(sql `strftime('%s', 'now')`),
});
export const projectMembers = sqliteTable('project_members', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull().references(() => projects.id),
    userId: integer('user_id').notNull().references(() => users.id),
    role: text('role').notNull().default('viewer'),
    joinedAt: integer('joined_at').default(sql `strftime('%s', 'now')`),
});
export const folders = sqliteTable('folders', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    projectId: integer('project_id').notNull().references(() => projects.id),
    parentId: integer('parent_id').references(() => folders.id),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
});
export const canvases = sqliteTable('canvases', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    projectId: integer('project_id').notNull().references(() => projects.id),
    folderId: integer('folder_id').references(() => folders.id),
    yjsData: text('yjs_data'),
    previewText: text('preview_text'),
    thumbnail: text('thumbnail'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
    updatedAt: integer('updated_at').default(sql `strftime('%s', 'now')`),
});
export const canvasRecycleBin = sqliteTable('canvas_recycle_bin', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    canvasId: integer('canvas_id').notNull().references(() => canvases.id),
    projectId: integer('project_id').notNull().references(() => projects.id),
    deletedBy: integer('deleted_by').notNull().references(() => users.id),
    deletedAt: integer('deleted_at').default(sql `strftime('%s', 'now')`),
    expiresAt: integer('expires_at').notNull(),
});
export const nodeCards = sqliteTable('node_cards', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull().references(() => projects.id),
    name: text('name').notNull(),
    content: text('content').notNull(),
    type: text('type').notNull().default('text'),
    color: text('color').notNull().default('#ffffff'),
    tags: text('tags'),
    useCount: integer('use_count').notNull().default(0),
    createdBy: integer('created_by').notNull().references(() => users.id),
    folderId: integer('folder_id').references(() => nodePoolFolders.id),
    description: text('description'),
    thumbnail: text('thumbnail'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
});
export const nodePoolFolders = sqliteTable('node_pool_folders', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').notNull().references(() => projects.id),
    name: text('name').notNull(),
    parentId: integer('parent_id').references(() => nodePoolFolders.id),
    sortOrder: integer('sort_order').notNull().default(0),
    collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
});
export const settings = sqliteTable('settings', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id),
    key: text('key').notNull(),
    value: text('value').notNull(),
    category: text('category').notNull().default('general'),
});
export const files = sqliteTable('files', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    filename: text('filename').notNull(),
    path: text('path').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull(),
    uploaderId: integer('uploader_id').notNull().references(() => users.id),
    projectId: integer('project_id').references(() => projects.id),
    createdAt: integer('created_at').default(sql `strftime('%s', 'now')`),
});
