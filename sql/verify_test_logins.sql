-- ============================================================
-- VERIFY TEST LOGINS — one glance, PASS/FAIL per layer
-- ------------------------------------------------------------
-- Read-only. Safe to run as often as you like.
--
-- Use this AFTER sql/create_test_users_direct.sql to confirm the whole
-- stack, layer by layer. Each check returns check_name + ok, so you can
-- scan one result set instead of hunting across many grids.
--
-- ok = t  → that layer is fine, ignore it.
-- ok = f  → that layer is the problem; the note tells you what to do.
-- ============================================================

WITH checks AS (

  -- 1. AUTH: the account exists, is confirmed, and the password verifies
  SELECT '1. auth: password verifies' AS check_name,
         bool_and(u.encrypted_password = crypt('Test@123', u.encrypted_password)) AS ok,
         't = correct password stored · f = re-run create_test_users_direct.sql' AS note
    FROM auth.users u
    JOIN public.portal_users p ON p.auth_id = u.id
   WHERE p.email LIKE 'test.%@portal.test'

  UNION ALL

  -- 2. AUTH: GoTrue can actually authenticate (the 500 we chased)
  SELECT '2. auth: GoTrue signed in at least once',
         count(*) FILTER (WHERE i.last_sign_in_at IS NOT NULL) > 0,
         't = credentials are valid · f = still 500 → use scripts/create_test_logins.mjs'
    FROM auth.identities i
    JOIN public.portal_users p ON p.auth_id = i.user_id
   WHERE p.email LIKE 'test.%@portal.test' AND i.provider = 'email'

  UNION ALL

  -- 3. AUTH: every auth user has an email identity row (GoTrue v2 needs it)
  SELECT '3. auth: identity row present',
         NOT EXISTS (
           SELECT 1 FROM public.portal_users p
            WHERE p.email LIKE 'test.%@portal.test'
              AND NOT EXISTS (SELECT 1 FROM auth.identities i
                               WHERE i.user_id = p.auth_id AND i.provider = 'email')),
         't = fine · f = re-run create_test_users_direct.sql'

  UNION ALL

  -- 4. PORTAL: the portal_users row each login needs
  SELECT '4. portal: row per login',
         count(*) = count(*) FILTER (WHERE p.auth_id IS NOT NULL AND p.is_active),
         't = fine · f = run sql/provision_test_logins.sql'
    FROM public.portal_users p
   WHERE p.email LIKE 'test.%@portal.test'

  UNION ALL

  -- 5. ROLES: which of the 7 roles have a test user
  SELECT '5. roles: 5 of 7 covered (no super_admin/scanner gap)',
         count(DISTINCT p.role) >= 5,
         't = expected · scanner + super_admin are optional (super_admin needs --include-admin)'
    FROM public.portal_users p
   WHERE p.email LIKE 'test.%@portal.test'

  UNION ALL

  -- 6. INCHARGE: badge + selection, or the Dept Incharge page shows
  --    "Not a Dept Incharge" and the v39 Attendance tab is empty
  SELECT '6. incharge: badge + selection wired',
         EXISTS (
           SELECT 1 FROM public.portal_users p
            WHERE p.email = 'test.incharge@portal.test'
              AND p.badge_number IS NOT NULL)
         AND EXISTS (
           SELECT 1 FROM public.department_incharge_selections s
            WHERE s.badge_number = (
              SELECT badge_number FROM public.portal_users
               WHERE email = 'test.incharge@portal.test')
              AND s.selected_by IN ('create_test_users_direct','provision_test_logins')),
         't = ready · f = needs an OPEN schedule with a deployed sewadar; deploy one, then re-run create_test_users_direct.sql'

  UNION ALL

  -- 7. V39: the Attendance tab needs these RPCs to exist
  SELECT '7. v39: attendance RPCs installed',
         count(*) = 5,
         't = fine · f = run sql/v39_attendance_analytics.sql in the SQL editor'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('attendance_scope_centres','attendance_allowed_depts',
                       'attendance_daily_summary','attendance_sewadar_summary',
                       'attendance_scanner_ops')

  UNION ALL

  -- 8. V39 mirror parity (CI fails without it)
  SELECT '8. v39: migration mirror present',
         to_regclass('public.dp_attendance_sessions') IS NOT NULL,
         't = fine · f = v39 was not applied to THIS database'

)

SELECT check_name, ok,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       note
  FROM checks
 ORDER BY check_name;


-- ============================================================
-- ROLES ACTUALLY PRESENT (for reference)
-- ============================================================
SELECT p.role,
       p.email,
       p.centre,
       p.badge_number,
       p.is_active,
       (u.id IS NOT NULL) AS has_auth_user
  FROM public.portal_users p
  LEFT JOIN auth.users u ON u.id = p.auth_id
 WHERE p.email LIKE 'test.%@portal.test'
 ORDER BY p.role, p.email;


-- ============================================================
-- INCHARGE DETAIL — if check 6 failed, this shows why
-- ============================================================
SELECT p.badge_number AS incharge_badge,
       p.centre,
       (SELECT count(*) FROM public.department_incharge_selections s
         WHERE s.badge_number = p.badge_number) AS selections_for_badge,
       (SELECT count(*) FROM public.deployments d
         JOIN public.deployment_schedules sc ON sc.id = d.schedule_id
        WHERE sc.status = 'open'
          AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       ) AS open_deployments_available
  FROM public.portal_users p
 WHERE p.email = 'test.incharge@portal.test';
