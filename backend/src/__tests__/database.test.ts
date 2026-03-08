/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import { eq, and, or, like } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { users, groups, projects, canvases, folders, nodeCards } from '../database/schema.js'
import type { NewUser, NewProject, NewCanvas, NewFolder, NewNodeCard } from '../database/schema.js'

describe('Database Integration Tests', () => {
  let db: any
  let drizzleInstance: any

  beforeEach(async () => {
    const SQL = await initSqlJs()
    db = new SQL.Database()

    // Enable foreign key constraints
    db.run('PRAGMA foreign_keys = ON')

    // Create tables
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        avatar TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL,
        invite_code TEXT NOT NULL UNIQUE,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL,
        group_id INTEGER,
        thumbnail TEXT,
        is_public INTEGER DEFAULT 0,
        is_collaborative INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (owner_id) REFERENCES users(id)
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS canvases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        folder_id INTEGER,
        yjs_data TEXT,
        preview_text TEXT,
        thumbnail TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        parent_id INTEGER,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS node_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        color TEXT DEFAULT '#ffffff',
        tags TEXT,
        use_count INTEGER DEFAULT 0,
        created_by INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `)

    drizzleInstance = drizzle(db, { schema: { users, groups, projects, canvases, folders, nodeCards } })
  })

  afterEach(() => {
    if (db) db.close()
  })

  describe('Users Table', () => {
    it('should insert and retrieve user', async () => {
      const newUser: NewUser = { email: 'test@example.com', password: 'hashed_password', nickname: 'Test User', avatar: 'avatar.jpg' }
      const result = await drizzleInstance.insert(users).values(newUser).returning().get()
      expect(result).toBeDefined()
      expect(result.id).toBeGreaterThan(0)
      expect(result.email).toBe('test@example.com')
    })

    it('should query user by email', async () => {
      const userData: NewUser = { email: 'query@example.com', password: 'hash', nickname: 'QueryUser' }
      await drizzleInstance.insert(users).values(userData)
      const user = await drizzleInstance.select().from(users).where(eq(users.email, 'query@example.com')).get()
      expect(user).toBeDefined()
      expect(user.email).toBe('query@example.com')
    })

    it('should update user', async () => {
      const userData: NewUser = { email: 'update@example.com', password: 'hash', nickname: 'Original Nick' }
      const inserted = await drizzleInstance.insert(users).values(userData).returning().get()
      await drizzleInstance.update(users).set({ nickname: 'Updated Nick' }).where(eq(users.id, inserted.id))
      const updated = await drizzleInstance.select().from(users).where(eq(users.id, inserted.id)).get()
      expect(updated.nickname).toBe('Updated Nick')
    })

    it('should delete user', async () => {
      const userData: NewUser = { email: 'delete@example.com', password: 'hash', nickname: 'DeleteUser' }
      const inserted = await drizzleInstance.insert(users).values(userData).returning().get()
      await drizzleInstance.delete(users).where(eq(users.id, inserted.id))
      const deleted = await drizzleInstance.select().from(users).where(eq(users.id, inserted.id)).get()
      expect(deleted).toBeUndefined()
    })
  })

  describe('Projects Table', () => {
    it('should insert project with owner', async () => {
      const user: NewUser = { email: 'project@example.com', password: 'hash', nickname: 'ProjectUser' }
      const insertedUser = await drizzleInstance.insert(users).values(user).returning().get()
      const projectData: NewProject = { name: 'Test Project', description: 'Test Description', ownerId: insertedUser.id, thumbnail: 'thumb.jpg', isPublic: false }
      const project = await drizzleInstance.insert(projects).values(projectData).returning().get()
      expect(project).toBeDefined()
      expect(project.ownerId).toBe(insertedUser.id)
      expect(project.isPublic).toBe(false)
    })

    it('should query projects by owner', async () => {
      const user: NewUser = { email: 'multi@example.com', password: 'hash', nickname: 'MultiUser' }
      const insertedUser = await drizzleInstance.insert(users).values(user).returning().get()
      const projectData: NewProject = { name: 'Project 1', ownerId: insertedUser.id, isPublic: false }
      await drizzleInstance.insert(projects).values(projectData)
      const projectData2: NewProject = { name: 'Project 2', ownerId: insertedUser.id, isPublic: false }
      await drizzleInstance.insert(projects).values(projectData2)
      const userProjects = await drizzleInstance.select().from(projects).where(eq(projects.ownerId, insertedUser.id)).all()
      expect(userProjects).toHaveLength(2)
    })
  })

  describe('Canvases Table', () => {
    it('should insert canvas with project', async () => {
      const user: NewUser = { email: 'canvas@example.com', password: 'hash', nickname: 'CanvasUser' }
      const insertedUser = await drizzleInstance.insert(users).values(user).returning().get()
      const projectData: NewProject = { name: 'Canvas Project', ownerId: insertedUser.id, isPublic: false }
      const insertedProject = await drizzleInstance.insert(projects).values(projectData).returning().get()
      const canvasData: NewCanvas = { name: 'Test Canvas', projectId: insertedProject.id, yjsData: 'base64data' }
      const canvas = await drizzleInstance.insert(canvases).values(canvasData).returning().get()
      expect(canvas).toBeDefined()
      expect(canvas.projectId).toBe(insertedProject.id)
    })
  })

  describe('Foreign Key Constraints', () => {
    it('should enforce user->projects relationship', async () => {
      const invalidProject: NewProject = { name: 'Invalid Project', ownerId: 99999, isPublic: false }
      await expect(async () => { await drizzleInstance.insert(projects).values(invalidProject) }).rejects.toThrow()
    })

    it('should enforce project->canvas relationship', async () => {
      const invalidCanvas: NewCanvas = { name: 'Invalid Canvas', projectId: 99999, yjsData: 'data' }
      await expect(async () => { await drizzleInstance.insert(canvases).values(invalidCanvas) }).rejects.toThrow()
    })
  })
})
