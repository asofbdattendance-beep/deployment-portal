import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/logic.js'],
      reporter: ['text', 'html'],
      // production guard: the pure domain logic must stay fully exercised
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
})
