import { describe, it, expect, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

// Mock window APIs not available in jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: vi.fn().mockReturnValue(false),
    media: query,
  })),
})

// Increase timeout for all tests
vi.setConfig({ testTimeout: 10000 })
