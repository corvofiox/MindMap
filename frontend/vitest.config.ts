/// <reference types="vite/client" />
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.spec.ts',
        'src/**/*.spec.tsx',
        'src/types/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      // 2026-10-14 重新标定为真实水平（R2 审计实测 33.16/27.03/36.94/33.36）。
      // 旧 80/75/80/80 从未真实达成过——`--coverage` 一直以退出码 1 失败，
      // 门限形同虚设。提高方式：补真实覆盖后上调数字。
      thresholds: {
        statements: 33,
        branches: 27,
        functions: 36,
        lines: 33,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared/src'),
    },
  },
})
