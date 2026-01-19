import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Vitest Setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should pass', () => {
    expect(1 + 1).toBe(2)
  })
})
