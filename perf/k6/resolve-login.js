/* global __ENV:readonly */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

// Load probe for the badge→email resolve-login edge function.
//
// READ THIS BEFORE RUNNING:
// - Every request WRITES one row to public.login_attempts (rate-limit
//   counter, pruned by check_login_rate). NEVER run this against production —
//   it pollutes the counter table and burns real rate-limit budget.
// - Run only against a local (`supabase start`) or staging project URL.
// - k6 is not installed in this repo's CI; install from https://k6.io/docs/get-started/installation/
//
// Usage:
//   RESOLVE_URL=http://127.0.0.1:54321/functions/v1/resolve-login \
//   RESOLVE_BADGE=SC123 \
//   k6 run perf/k6/resolve-login.js
//
// Optional: RESOLVE_ANON_KEY (anon key for the Authorization header),
//   VUS (default 5), DURATION (default 30s).

const BASE = __ENV.RESOLVE_URL;
const BADGE = __ENV.RESOLVE_BADGE;

if (!BASE) {
  fail('RESOLVE_URL is required (local/staging functions URL only — never production).');
}
if (!BADGE) {
  fail('RESOLVE_BADGE is required (a badge number that exists in the target project).');
}
if (/supabase\.co/.test(BASE) && !__ENV.RESOLVE_CONFIRM_CLOUD) {
  fail('Target looks like Supabase Cloud. Refusing: set RESOLVE_CONFIRM_CLOUD=1 only if this is a staging project, never production.');
}

const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // resolve-login does one indexed badge lookup + one rate-limit RPC;
    // p95 should stay well under the 800ms UI debounce budget.
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<800'],
  },
};

const headers = { 'Content-Type': 'application/json' };
if (__ENV.RESOLVE_ANON_KEY) {
  headers['apikey'] = __ENV.RESOLVE_ANON_KEY;
  headers['Authorization'] = `Bearer ${__ENV.RESOLVE_ANON_KEY}`;
}

export default function () {
  const res = http.post(BASE, JSON.stringify({ identifier: BADGE }), { headers });
  // 200 (resolved), 404 (unknown badge — also fine for load purposes), or
  // 429 (rate limiter working as designed under burst). All three prove the
  // function is alive and answering; 5xx is the failure mode we watch for.
  check(res, {
    'no server errors': (r) => r.status !== 500 && r.status !== 502 && r.status !== 503,
    'well-formed response': (r) => {
      try {
        const body = r.json();
        return r.status === 200 ? typeof body.email === 'string' : typeof body.error === 'string';
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
