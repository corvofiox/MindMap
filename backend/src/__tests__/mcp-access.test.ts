/**
 * MCP canvas access-control tests.
 *
 * `access.ts` had 0% coverage, yet it is the only thing standing between a
 * personal access token and every canvas in the database. These tests run
 * `resolveCanvasAccess` against a real in-memory SQLite database seeded through
 * the shared harness, so the membership query itself is exercised — not a stub.
 *
 * The user-facing error strings are pinned here as well: agents and humans read
 * them, and they distinguish "fix your id" from "ask for access".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

import {
  createTestDatabase,
  seedCanvas,
  seedMember,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { resolveCanvasAccess, accessErrorMessage } = await import('../mcp/access.js')

describe('resolveCanvasAccess (real DB)', () => {
  let t: TestDatabase
  let ownerId: number
  let memberId: number
  let outsiderId: number
  let projectId: number

  beforeEach(() => {
    t = createTestDatabase()
    ownerId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    memberId = seedUser(t.raw, 'member@test.com', 'hash', 'Member')
    outsiderId = seedUser(t.raw, 'outsider@test.com', 'hash', 'Outsider')
    projectId = seedProject(t.raw, ownerId, 'Project Name')
  })

  it('grants the project owner and returns the canvas/project identity', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Canvas Name')

    const result = await resolveCanvasAccess(canvasId, ownerId)

    expect(result.status).toBe('ok')
    expect(result.access).toEqual({
      canvasId,
      projectId,
      canvasName: 'Canvas Name',
      projectName: 'Project Name',
    })
  })

  it('grants an explicit project member', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Shared')
    seedMember(t.raw, projectId, memberId, 'editor')

    const result = await resolveCanvasAccess(canvasId, memberId)

    expect(result.status).toBe('ok')
    expect(result.access.canvasId).toBe(canvasId)
    expect(result.access.projectId).toBe(projectId)
  })

  it('grants a viewer-role member too (role is not consulted here)', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Readonly')
    seedMember(t.raw, projectId, memberId, 'viewer')

    expect((await resolveCanvasAccess(canvasId, memberId)).status).toBe('ok')
  })

  it('denies an unrelated user with reason forbidden', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Private')

    const result = await resolveCanvasAccess(canvasId, outsiderId)

    expect(result.status).toBe('denied')
    expect(result.reason).toBe('forbidden')
  })

  it('denies a member of a different project', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Mine')
    const otherProjectId = seedProject(t.raw, outsiderId, 'Other Project')
    seedMember(t.raw, otherProjectId, memberId, 'editor')

    const result = await resolveCanvasAccess(canvasId, memberId)
    expect(result.status).toBe('denied')
    expect(result.reason).toBe('forbidden')
  })

  it('reports a nonexistent canvas as not-found', async () => {
    const result = await resolveCanvasAccess(999_999, ownerId)

    expect(result.status).toBe('denied')
    expect(result.reason).toBe('not-found')
  })

  it('reports a canvas whose project row is missing as forbidden', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Orphan')
    // Deleting the project is normally blocked by the canvas FK, so simulate the
    // dangling row the way a corrupted/partially-restored database would.
    t.raw.pragma('foreign_keys = OFF')
    t.raw.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    t.raw.pragma('foreign_keys = ON')

    const result = await resolveCanvasAccess(canvasId, ownerId)

    expect(result.status).toBe('denied')
    expect(result.reason).toBe('forbidden')
  })

  it('does not grant access just because the user owns another project', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Target')
    seedProject(t.raw, outsiderId, 'Outsider Own')

    expect((await resolveCanvasAccess(canvasId, outsiderId)).status).toBe('denied')
  })
})

describe('accessErrorMessage', () => {
  it('uses the 不存在 wording for not-found, naming the id', () => {
    const message = accessErrorMessage(42, 'not-found')
    expect(message).toContain('不存在')
    expect(message).toContain('42')
    expect(message).toContain('listCanvases')
  })

  it('uses the 无权访问 wording for forbidden, naming the id', () => {
    const message = accessErrorMessage(7, 'forbidden')
    expect(message).toContain('无权访问')
    expect(message).toContain('7')
    expect(message).not.toContain('不存在')
  })

  it('returns distinct strings for the two reasons', () => {
    expect(accessErrorMessage(1, 'not-found')).not.toBe(accessErrorMessage(1, 'forbidden'))
  })
})
