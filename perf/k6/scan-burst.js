/* global __ENV:readonly, __VU:readonly, __ITER:readonly */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

// Load probe for the scan write path: many scanners firing scan_in repeatedly.
// Measures whether the portal (and PostgREST/Supabase) survives the scanner
// storm, not just one request. Mirrors perf/k6/read-burst.js.
//
// Run only against local/staging. k6 is not in CI; install from k6.io.
//
// Usage:
//   SCAN_BURST_URL=http://127.0.0.1:54321/rest/v1/rpc/scan_in \
//   SCAN_BURST_ANON_KEY=... \
//   SCAN_BURST_SCHEDULE=<deployment schedule uuid> \
//   k6 run perf/k6/scan-burst.js
//
// Optional: SCAN_BURST_CENTRE (default TEST), VUS (default 50),
// DURATION (default 30s), INTERVAL_MS (default 500).

const URL = __ENV.SCAN_BURST_URL;
const ANON = __ENV.SCAN_BURST_ANON_KEY;
const SCHEDULE = __ENV.SCAN_BURST_SCHEDULE;
const CENTRE = __ENV.SCAN_BURST_CENTRE || 'TEST';

if (!URL) fail('SCAN_BURST_URL is required (local/staging only).');
if (!SCHEDULE) fail('SCAN_BURST_SCHEDULE is required (a deployment schedule uuid).');
if (/supabase\.co/.test(URL) && !__ENV.SCAN_BURST_CONFIRM_CLOUD) {
  fail('Target looks like Supabase Cloud. Refusing: set SCAN_BURST_CONFIRM_CLOUD=1 only for staging.');
}

const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '30s';
const INTERVAL = Number(__ENV.INTERVAL_MS || 500);

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  // Distinct badge per VU so the server's idempotency nonce (not the badge)
  // is what dedups; a fresh nonce per iteration keeps every scan a real write.
  const badge = `PROBE${String(__VU).padStart(4, '0')}`;
  const nonce = `${__VU}-${__ITER}-${Date.now()}`;
  const body = JSON.stringify({
    p_badge: badge,
    p_schedule: SCHEDULE,
    p_ts: new Date().toISOString(),
    p_nonce: nonce,
    p_centre: CENTRE,
    p_is_manual: false,
  });
  const headers = { 'Content-Type': 'application/json' };
  if (ANON) {
    headers['apikey'] = ANON;
    headers['Authorization'] = `Bearer ${ANON}`;
  }
  const res = http.post(URL, body, { headers });
  check(res, {
    'no server errors': (r) => r.status !== 500 && r.status !== 502 && r.status !== 503 && r.status !== 429,
    'well-formed': (r) => { try { r.json(); return true } catch { return false } },
  });
  sleep(INTERVAL / 1000);
}
