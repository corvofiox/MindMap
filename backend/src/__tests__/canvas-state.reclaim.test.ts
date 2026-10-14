/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Idle canvas-state reclaim (websocket/canvas-state.ts reclaimIdleCanvasStates).
 *
 * The scan is module-private in behaviour but exported for tests (like
 * _setRoomForTesting); production arms it through ensureIdleReclaimTimer's
 * 5-minute interval. Driving the exported scan directly keeps the tests
 * deterministic: the clock is faked (Date only — the persist debounce keeps
 * running on the real clock) and no cross-test interval state can leak.
 *
 * Only the DB connection and the logger are mocked; canvas-state logic, Yjs,
 * and the websocket module (whose getCanvasActiveUsers feeds the room check)
 * are the real implementations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { db } from '../database/connection.js'
import {
  loadCanvasStateFromDb,
  reclaimIdleCanvasStates,
  removeCanvasState,
  getCanvasState,
  getCanvasDoc,
  getCanvasStatesSnapshot,
  isCanvasStatePersisted,
  IDLE_STATE_RECLAIM_MS,
} from '../websocket/canvas-state.js'
import { _setRoomForTesting } from '../websocket/index.js'
import { log } from '../utils/logger.js'

vi.mock('../database/connection.js', () => ({
  db: {
    query: {
      // No canvas rows: loadCanvasStateFromDb still creates an empty loaded state
      canvases: { findFirst: vi.fn().mockResolvedValue(undefined) },
      projects: { findFirst: vi.fn().mockResolvedValue(undefined) },
      projectMembers: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}))
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

const RECLAIM_LOG = 'Reclaiming idle canvas state'
let roomAwareness: awarenessProtocol.Awareness | undefined

function sharedNodes(canvasId: number): Y.Map<unknown> {
  const doc = getCanvasDoc(canvasId)
  expect(doc).toBeDefined()
  return (doc!.getMap('root').get('nodes') as Y.Map<unknown>) ?? doc!.getMap('nodes')
}

/** Wait (real clock) until the debounced persist of `canvasId` has landed. */
async function waitForPersist(canvasId: number) {
  for (let i = 0; i < 50 && !isCanvasStatePersisted(canvasId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(isCanvasStatePersisted(canvasId)).toBe(true)
}

describe('reclaimIdleCanvasStates (websocket/canvas-state.ts:203-237)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(db.query.canvases.findFirst as any).mockResolvedValue(undefined)
    // Fake the clock only: reclaim's 5-minute window compares Date.now()
    // against lastActivityAt, while the persist debounce stays on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    if (roomAwareness) {
      roomAwareness.destroy()
      roomAwareness = undefined
    }
    for (const canvasId of getCanvasStatesSnapshot().keys()) {
      removeCanvasState(canvasId)
      _setRoomForTesting(canvasId, null)
    }
    vi.useRealTimers()
  })

  it('reclaims a clean, idle canvas state: doc destroyed and state removed', async () => {
    const canvasId = 400
    await loadCanvasStateFromDb(canvasId)
    const state = getCanvasState(canvasId)
    expect(state).toBeDefined()
    const destroySpy = vi.spyOn(state!.doc, 'destroy')

    // Six quiet minutes pass — beyond IDLE_STATE_RECLAIM_MS (5 min)
    vi.setSystemTime(Date.now() + IDLE_STATE_RECLAIM_MS + 60_000)

    await reclaimIdleCanvasStates()

    expect(log).toHaveBeenCalledWith(RECLAIM_LOG, expect.objectContaining({ canvasId }))
    expect(destroySpy).toHaveBeenCalled()
    expect(getCanvasState(canvasId)).toBeUndefined()
    expect(getCanvasDoc(canvasId)).toBeUndefined()
  })

  it('keeps a doc with recent activity (clean but idle for less than the window)', async () => {
    const canvasId = 401
    await loadCanvasStateFromDb(canvasId)

    // A real edit: dirty at first, then persisted by the debounced persist
    sharedNodes(canvasId).set('n1', { text: 'recent' })
    await waitForPersist(canvasId)

    // One quiet minute — inside the 5-minute window
    vi.setSystemTime(Date.now() + 60_000)

    await reclaimIdleCanvasStates()

    expect(getCanvasState(canvasId)).toBeDefined()
    expect(getCanvasDoc(canvasId)).toBeDefined()
    expect(log).not.toHaveBeenCalledWith(RECLAIM_LOG, expect.anything())
  })

  it('keeps an idle doc while its room still has active users (real getCanvasActiveUsers)', async () => {
    const canvasId = 402
    await loadCanvasStateFromDb(canvasId)
    const destroySpy = vi.spyOn(getCanvasState(canvasId)!.doc, 'destroy')

    roomAwareness = new awarenessProtocol.Awareness(new Y.Doc())
    _setRoomForTesting(canvasId, {
      id: canvasId,
      clients: new Set(),
      activeUsers: new Map<number, any>([
        [1, { userId: 1, email: 'a@b.c', nickname: 'tester', avatar: null, role: 'editor', joinedAt: Date.now() }],
      ]),
      userConnectionCounts: new Map([[1, 1]]),
      awareness: roomAwareness,
    })

    // Idle far beyond the window — only the live room keeps it alive
    vi.setSystemTime(Date.now() + IDLE_STATE_RECLAIM_MS + 60_000)

    await reclaimIdleCanvasStates()

    expect(getCanvasState(canvasId)).toBeDefined()
    expect(destroySpy).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalledWith(RECLAIM_LOG, expect.anything())
  })

  it('double-check: a doc that turns active DURING the scan is not destroyed (TOCTOU guard)', async () => {
    const canvasId = 403
    await loadCanvasStateFromDb(canvasId)
    const state = getCanvasState(canvasId)!
    const destroySpy = vi.spyOn(state.doc, 'destroy')

    // Idle beyond the window — the scan's FIRST pass will see clean + idle
    vi.setSystemTime(Date.now() + IDLE_STATE_RECLAIM_MS + 60_000)

    // Start the scan without awaiting: it suspends at its dynamic-import
    // boundary (websocket/index.js) between the first pass and the re-check.
    const scan = reclaimIdleCanvasStates()

    // This synchronous continuation runs BEFORE the re-check happens —
    // an edit arriving exactly in that gap is what the double-check exists for.
    sharedNodes(canvasId).set('late-arrival', { text: 'edited during reclaim' })

    await scan

    // The re-check caught the new activity: no destroy, state kept (same instance)
    expect(getCanvasState(canvasId)).toBe(state)
    expect(destroySpy).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalledWith(RECLAIM_LOG, expect.anything())
  })
})
