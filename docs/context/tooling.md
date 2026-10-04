# Quality tooling, migrations & env (extracted from CONTEXT.md 2026-10-04)

> Extracted to shrink the always-on CONTEXT.md. Read this before CI/test/env/deploy work.

## Quality tooling

- `npm test` — Vitest unit tests (54 files, 1394 passed | 8 skipped).
- `npm run test:coverage` — Vitest + v8 coverage on `src/lib/logic.js` and `src/lib/attendance.js` (thresholds: ≥95% stmts, ≥90% branch, ≥95% funcs/lines — currently 100%/99.7% and 99.3%/97.8%).
- `npm run lint` — ESLint (flat config `eslint.config.js`; react-hooks + react-refresh rules; `coverage/` and `dist/` ignored).
- `npm run build` — Vite production build (code-split; `xlsx` loads on demand).
- `.github/workflows/ci.yml` — GitHub Actions runs lint + tests + coverage + build on every push/PR, plus mobile e2e, PWA shell, and migration parity/apply; the chromium desktop e2e (`e2e-desktop`, queue-matrix) is gated to `release/attendance-go-live-2026-10-03` or `workflow_dispatch` until the repaired matrix has soaked.

## SQL migrations (run in order in Supabase)

**Full migration-by-migration reference (v1–v64, ~77 KB): `docs/context/migrations.md`** — read it on demand when
writing or running DB schema changes; it carries the per-version rationale, "safe to re-run" notes, and the
run-AFTER ordering. Quick index: `ls sql/` (numeric order) — `sql/` and `supabase/migrations/` are byte-identical
mirrors (CI-enforced). Non-destructive is the norm; `sql/reset_deployments.sql` is a preview-only utility, never a migration.

## Env / deploy (extracted)

## Env / deploy

- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon key only, never service_role). `.env` is gitignored.
- Vercel: set both vars in Project Settings → Environment Variables, then redeploy.
- Git: this repo is separate from `sewadar-attendance`; remote `asofbdattendance-beep/deployment-portal.git`, branch `feature_deployment_portal_02082026`.
