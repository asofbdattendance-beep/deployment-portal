-- v3: data-safety hardening
--  1) unique schedule name (protects against duplicate schedules)
--  2) audit_log table for hard deletes (soft-delete / audit trail)

-- duplicate-schedule protection
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'deployment_schedules'
      AND indexdef ILIKE '%unique%name%'
  ) THEN
    -- safe unique index on lower(name) so "Visit" and "visit" collide too
    CREATE UNIQUE INDEX IF NOT EXISTS deployment_schedules_name_key ON deployment_schedules ((lower(name)));
  END IF;
END $$;

-- audit log: records every destructive action with full payload for undo/restore
CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  table_name text NOT NULL,
  record_id uuid,
  schedule_id uuid,
  payload jsonb,
  acted_by text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_schedule_id_idx ON audit_log (schedule_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);

-- RLS: super_admin can read/write, others read-only
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'audit_log_select') THEN
    CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'audit_log_insert') THEN
    CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (
      public.get_portal_user_role() = 'super_admin'
    );
  END IF;
END $$;
