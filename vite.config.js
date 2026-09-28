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
      include: [
        // pure domain logic
        'src/lib/logic.js',
        'src/lib/attendance.js',
        // the scanner state machine -- this is the subsystem that writes
        // attendance rows, so it belongs under the gate too
        'src/hooks/useScanHandler.js',
        'src/lib/offlineQueue.js',
        'src/lib/scannerUtils.js',
      ],
      reporter: ['text', 'html'],
      // Aggregate floors are a coarse "did this collapse?" net only, kept low
      // on purpose so an in-flight change to one file cannot redden CI. The
      // real gate is the per-file block below: a global threshold lets a
      // near-100% file (logic.js) arithmetically absorb a regression in a
      // weaker sibling (attendance.js) and still report green, which defeats
      // the point of the gate.
      thresholds: {
        statements: 70,
        branches: 80,
        functions: 65,
        lines: 72,
        // Per-file floors, each set just below the measured value so the gate
        // is real without being brittle.
        //
        // HONEST CAVEAT: useScanHandler.js, offlineQueue.js and scannerUtils.js
        // carry genuine untested surface and sit far below 90% -- offlineQueue
        // covers only ~36% of statements and half of its functions. These
        // floors pin current reality so it cannot silently rot further; they
        // are NOT an endorsement of that coverage, and they should be raised
        // as tests land. offlineQueue.js leaves lines 129-177 and 182-263 and
        // 49 functions entirely unexercised.
        //
        // The three scanner files are actively being worked on, so they carry
        // a couple of points of slack to absorb in-flight edits.
        'src/lib/logic.js': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'src/lib/attendance.js': {
          statements: 99,
          branches: 97,
          functions: 99,
          lines: 99,
        },
        'src/lib/scannerUtils.js': {
          statements: 86,
          branches: 85,
          functions: 89,
          lines: 95,
        },
        'src/hooks/useScanHandler.js': {
          statements: 82,
          branches: 78,
          functions: 74,
          lines: 85,
        },
        'src/lib/offlineQueue.js': {
          statements: 35,
          branches: 34,
          functions: 35,
          lines: 40,
        },
      },
    },
  },
  }
})
