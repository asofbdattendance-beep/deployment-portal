import { defineConfig, devices } from '@playwright/test'

// Phase D (T2): E2E against a mock Supabase backend — no network, no real
// project, no stark writes anywhere. The mock (tests/e2e/mock-supabase.mjs)
// serves auth + REST + RPC; the app is pointed at it through env only.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    // The repo serves local TLS when certs/ exists (vite.config.js) — the
    // mock backend stays plain HTTP (supabase-js does not care).
    baseURL: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/e2e/mock-supabase.mjs',
      port: 54321,
      reuseExistingServer: true,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: true,
      env: {
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_ANON_KEY: 'e2e-anon-key',
      },
    },
  ],
})
