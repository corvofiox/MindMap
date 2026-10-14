/// <reference types="node" />
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        'src/types/**',
        'src/index.ts',
      ],
      // 2026-10-13 测试审视后重新标定。此前的 85/80/85/85 从未真实达成
      // （当时实际约 40%，且大量"测试"是断言恒真的假测试，门槛形同虚设）。
      // 现在的数字是全部真实测试下的实际水平，往下掉一格就会失败。
      // 提高门槛的正确方式：补真实覆盖，然后把这里的数字往上挪。
      // （未覆盖大头：WebSocket 协议层的部分分支、进程引导代码
      //   connection/init/stdio——stdio 由 scripts/mcp-stdio-smoke.mjs 实测。）
      thresholds: {
        statements: 76,
        branches: 68,
        functions: 75,
        lines: 78,
      },
    },
  },
})
