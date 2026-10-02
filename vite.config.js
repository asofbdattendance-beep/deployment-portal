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
    // The Playwright specs under tests/e2e are run by `npm run test:e2e`.
    // Vitest's default exclude does not cover them, so a bare `vitest run`
    // (and therefore CI's `npm run test:coverage`) loaded them and died on
    // "Playwright Test did not expect test.describe() to be called here" —
    // a red suite on a clean checkout, with the real unit results buried
    // under it. The two defaults are restated because supplying `exclude`
    // replaces them rather than extending them.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/e2e/**',
    ],
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
        // scanner UI + session state -- covered by component/hook suites,
        // gated so a regression here is visible to CI (V17)
        'src/lib/scanDisplay.js',
        'src/hooks/useScannerSession.js',
        'src/components/scanner/BarcodeScanner.jsx',
        'src/components/scanner/ScanResultPopup.jsx',
        'src/components/scanner/RecentScansTable.jsx',
        'src/components/scanner/enginePool.js',
        'src/components/scanner/cameraManager.js',
        'src/pages/ScannerPage.jsx',
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
        // HONEST CAVEAT (2026-10-02): the scanner UI files sit well below 90%
        // on branches -- BarcodeScanner 55%, ScannerPage 61%, enginePool 66%.
        // These floors pin current reality so it cannot silently rot further;
        // they are NOT an endorsement of that coverage, and they should be
        // raised as tests land.
        //
        // The scanner files are actively being worked on, so they carry
        // a couple of points of slack to absorb in-flight edits.
        //
        // NOTE: the v8 text reporter does not print a row for
        // src/lib/scanDisplay.js (measured 100% across the board -- see the
        // HTML report), but thresholds are evaluated on the underlying data
        // and still enforced for it.
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
          statements: 81,
          branches: 77,
          functions: 70,
          lines: 91,
        },
        'src/lib/scanDisplay.js': {
          statements: 98,
          branches: 98,
          functions: 98,
          lines: 98,
        },
        'src/hooks/useScannerSession.js': {
          statements: 74,
          branches: 65,
          functions: 74,
          lines: 84,
        },
        'src/components/scanner/BarcodeScanner.jsx': {
          statements: 69,
          branches: 53,
          functions: 73,
          lines: 81,
        },
        'src/components/scanner/ScanResultPopup.jsx': {
          statements: 72,
          branches: 65,
          functions: 75,
          lines: 77,
        },
        'src/components/scanner/RecentScansTable.jsx': {
          statements: 98,
          branches: 93,
          functions: 98,
          lines: 98,
        },
        'src/components/scanner/enginePool.js': {
          statements: 83,
          branches: 64,
          functions: 98,
          lines: 94,
        },
        'src/components/scanner/cameraManager.js': {
          statements: 79,
          branches: 66,
          functions: 71,
          lines: 86,
        },
        'src/pages/ScannerPage.jsx': {
          statements: 79,
          branches: 58,
          functions: 68,
          lines: 91,
        },
      },
    },
  },
  }
})
