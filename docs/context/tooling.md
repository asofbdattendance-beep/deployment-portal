# Quality tooling, migrations & env (extracted from CONTEXT.md 2026-10-04)

> Extracted to shrink the always-on CONTEXT.md. Read this before CI/test/env/deploy work.

## Quality tooling

- `npm test` — Vitest unit tests (82 files, 1766 passed | 8 skipped — incl. `LoginPage.test.jsx` dual-login,
  `realtimeDeploy.test.js` debounce/self-skip pins, `resolve-login/helpers.test.ts` badge matching,
  `perfTimings.test.js` latency-tripwire math).
- `npm run test:coverage` — Vitest + v8 coverage with per-file floors (~18 files incl. the scanner/offline set; `src/lib/offlineSync.js` gated at 84/78/71/88 — see `vite.config.js`).
- `npm run lint` — ESLint (flat config `eslint.config.js`; react-hooks + react-refresh rules; `coverage/` and `dist/` ignored).
- `npm run build` — Vite production build (code-split; `xlsx` loads on demand; emits `sw.js` + precache manifest).
- `.github/workflows/ci.yml` — GitHub Actions runs lint + tests + coverage + build on every push/PR, plus mobile e2e, PWA shell, migration parity/apply, AND the chromium desktop offline suite (`e2e-desktop`: queue-matrix + scanner-offline + offline-sync — drain after leaving the scanner page, drain after reload — plus the `offline-ladder` basics→advanced rung: online IN/OUT, queue basics, double-input dedupe, IN→OUT order, poison neighbour, permanent breaker, 5-burst, two-tab single replay). `workflow_dispatch` supported for manual re-runs.

## SQL migrations (run in order in Supabase)

**Full migration-by-migration reference (v1–v64, ~77 KB): `docs/context/migrations.md`** — read it on demand when
writing or running DB schema changes; it carries the per-version rationale, "safe to re-run" notes, and the
run-AFTER ordering. Quick index: `ls sql/` (numeric order) — `sql/` and `supabase/migrations/` are byte-identical
mirrors (CI-enforced). Non-destructive is the norm; `sql/reset_deployments.sql` is a preview-only utility, never a migration.
- Dual-login migrations (additive only, no existing table touched): `sql/v72_dual_login_badge_index.sql`
  (partial expression index `idx_portal_users_badge_norm` for badge lookup) ↔ `0075`; `sql/v73_login_rate_limit.sql`
  (new `public.login_attempts` + `check_login_rate(ip, identity, max, window)` SECURITY DEFINER used by `resolve-login`
  at 10/900s and by `create-login`/`manage-login` at 30/60s, fail-open) ↔ `0076`. RLS is enabled on `login_attempts`
  with no policies (= default deny for anon/authenticated; only the DEFINER function touches it) — so the planned v74
  RLS follow-up was deliberately skipped as a no-op migration.
- `supabase/functions/resolve-login` — no-JWT badge→email resolver (anon-safe: returns `{email}` only, generic 404,
  `Retry-After: 900` on 429). Deploys with `supabase functions deploy resolve-login` (user-run).

## Perf probes (`perf/k6/` — never against production)

- `perf/k6/resolve-login.js` — k6 load probe (default 5 VUs / 30s, p95 < 800ms, <5% failed). Every request writes a
  `login_attempts` row, so run ONLY against local (`supabase start`) or staging: `RESOLVE_URL=<functions-url>
  RESOLVE_BADGE=<badge> k6 run perf/k6/resolve-login.js`. The script refuses Supabase Cloud targets unless
  `RESOLVE_CONFIRM_CLOUD=1` (staging only — never prod). k6 is not installed in CI.

## Env / deploy (extracted)

## Env / deploy

- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon key only, never service_role). `.env` is gitignored.
- Vercel: set both vars in Project Settings → Environment Variables, then redeploy.
- Git: this repo is separate from `sewadar-attendance`; remote `asofbdattendance-beep/deployment-portal.git`, branch `feature_deployment_portal_02082026`.
