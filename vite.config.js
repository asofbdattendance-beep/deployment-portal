import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const certDir = path.join(here, 'certs')
const useHttps = fs.existsSync(path.join(certDir, 'local-cert.pem'))

export default defineConfig(({ command, mode }) => {
  // Fail fast on misconfigured deploys: dotenv files and the real environment
  // both count (Vite does not merge .env files into process.env itself).
  const env = { ...loadEnv(mode, here, ''), ...globalThis.process.env }
  if (command === 'build' && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — set them in .env or Vercel env vars')
  }
  return {
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    https: useHttps ? {
      key: fs.readFileSync(path.join(certDir, 'local-key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'local-cert.pem')),
    } : undefined,
  },
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
  }
})
