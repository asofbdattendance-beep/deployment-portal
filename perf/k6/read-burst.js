/* global __ENV:readonly */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

// Load probe for a dashboard "read burst": many viewers repeatedly firing the
// 4-5 query set a live page runs (aggregates + session log). Measures whether
// the portal survives the admin-viewer storm, not just one request.
//
// Run only against local/staging. k6 is not in CI; install from k6.io.
//
// Usage:
//   READ_BURST_URL=http://127.0.0.1:54321/rest/v1/rpc/attendance_daily_summary \
//   READ_BURST_ANON_KEY=... \
//   READ_BURST_BODY='{"p_schedule":"...","p_date":"2026-12-01"}' \
//   k6 run perf/k6/read-burst.js
//
// Optional: VUS (default 10), DURATION (default 30s), INTERVAL_MS (default 2000).

const URL = __ENV.READ_BURST_URL;
const ANON = __ENV.READ_BURST_ANON_KEY;
const BODY = __ENV.READ_BURST_BODY || '{}';

if (!URL) fail('READ_BURST_URL is required (local/staging only).');
if (/supabase\.co/.test(URL) && !__ENV.READ_BURST_CONFIRM_CLOUD) {
  fail('Target looks like Supabase Cloud. Refusing: set READ_BURST_CONFIRM_CLOUD=1 only for staging.');
}

const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const INTERVAL = Number(__ENV.INTERVAL_MS || 2000);

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const headers = { 'Content-Type': 'application/json' };
  if (ANON) {
    headers['apikey'] = ANON;
    headers['Authorization'] = `Bearer ${ANON}`;
  }
  const res = http.post(URL, BODY, { headers });
  check(res, {
    'no server errors': (r) => r.status !== 500 && r.status !== 502 && r.status !== 503 && r.status !== 429,
    'well-formed': (r) => { try { r.json(); return true } catch { return false } },
  });
  sleep(INTERVAL / 1000);
}
