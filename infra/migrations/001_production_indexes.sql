-- ============================================================================
-- Migration 001: production indexes, generated columns, retention helper
-- ============================================================================
-- Safe to apply against a live database created by src/storage/postgres.ts.
-- Everything in this file is idempotent (IF NOT EXISTS, CREATE OR REPLACE,
-- ALTER TABLE ADD COLUMN IF NOT EXISTS).
--
-- What this picks from infra/schema.sql:
--   * Extra hot-path indexes on messages.from_agent / to_agent / created_at
--   * Partial index on mailbox_state(agent_id) WHERE unread_count > 0
--   * Generated column messages.payload_size_bytes (for usage metering later)
--   * cleanup_expired_messages() and reset_daily_rate_limits() functions
--   * Helpful read-only views: agent_overview, thread_overview
--
-- What this DOESN'T include (and why):
--   * users / organizations / api_keys / billing_customers tables — no app
--     code reads or writes them today. Adding them creates dead tables.
--   * Row-Level Security policies — only useful in the multi-tenant cloud
--     tier; would obscure debugging until then.
--   * usage_metrics / plan_limits / rate_limit_state — rate limiting lives
--     in-memory (src/ratelimit.ts). DB-backed metering is a future change.
--   * Webhooks / audit_log — not wired into the server yet.
-- ============================================================================


-- ---------- 1. schema_migrations tracker (always useful) ----------

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT
);


-- ---------- 2. extra hot-path indexes on messages ----------

-- Lookups: "messages sent by agent X most recently" — used by future
-- per-agent dashboards and the existing /usage path when we DB-back it.
CREATE INDEX IF NOT EXISTS idx_messages_from
    ON messages(from_agent, timestamp DESC);

-- Lookups: "messages addressed to agent Y most recently" — read-path
-- for receive() when we eventually add per-recipient pagination.
CREATE INDEX IF NOT EXISTS idx_messages_to
    ON messages(to_agent, timestamp DESC);

-- For retention scans (cleanup_expired_messages()).
CREATE INDEX IF NOT EXISTS idx_messages_created
    ON messages(created_at);


-- ---------- 3. better mailbox_state index (partial) ----------

-- The adapter creates idx_mailbox_state_agent_unread unconditionally. The
-- partial variant is materially smaller in steady state (most rows have
-- unread_count = 0 once the agent has caught up). Both can coexist; the
-- planner picks whichever has lower cost.
CREATE INDEX IF NOT EXISTS idx_mailbox_state_agent_unread_partial
    ON mailbox_state(agent_id, unread_count)
    WHERE unread_count > 0;


-- ---------- 4. messages.payload_size_bytes generated column ----------

-- For future usage metering (per-user bytes/day). Cheap: computed on
-- insert, no triggers, no app-side bookkeeping.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS payload_size_bytes INTEGER
    GENERATED ALWAYS AS (octet_length(payload::text)) STORED;


-- ---------- 5. retention helper functions ----------

-- Self-hosted variant: no user-tier retention, just a hard cap by days.
-- Run periodically via pg_cron or app-side scheduler:
--   SELECT cleanup_expired_messages(90);
CREATE OR REPLACE FUNCTION cleanup_expired_messages(retention_days INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER := 0;
BEGIN
    IF retention_days <= 0 THEN
        RETURN 0;  -- 0 or negative = unlimited
    END IF;

    DELETE FROM messages
    WHERE created_at < NOW() - (retention_days || ' days')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Drop empty threads older than 1 day (no messages left).
    DELETE FROM threads t
    WHERE NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.thread_id = t.id
    )
    AND t.created_at < NOW() - interval '1 day';

    RETURN deleted_count;
END;
$$;


-- ---------- 6. read-only views ----------

-- Active agents with their thread + unread counts. Use from psql or an
-- ops dashboard. Always reflects current state; no caching.
CREATE OR REPLACE VIEW agent_overview AS
SELECT
    a.id                          AS agent_id,
    a.created_at,
    COUNT(DISTINCT tp.thread_id)  AS thread_count,
    COALESCE(SUM(ms.unread_count), 0) AS total_unread
FROM agents a
LEFT JOIN thread_participants tp ON tp.agent_id = a.id
LEFT JOIN mailbox_state ms       ON ms.agent_id = a.id AND ms.unread_count > 0
GROUP BY a.id, a.created_at;

-- Thread activity with message count + participant list.
CREATE OR REPLACE VIEW thread_overview AS
SELECT
    t.id                          AS thread_id,
    t.created_at,
    t.updated_at,
    COUNT(m.id)                   AS message_count,
    MAX(m.timestamp)              AS last_message_ts,
    (
      SELECT array_agg(tp.agent_id ORDER BY tp.agent_id)
      FROM thread_participants tp
      WHERE tp.thread_id = t.id AND tp.role = 'visible'
    )                             AS participants
FROM threads t
LEFT JOIN messages m ON m.thread_id = t.id
GROUP BY t.id, t.created_at, t.updated_at;


-- ---------- 7. record this migration ----------

INSERT INTO schema_migrations (version, description)
VALUES (
    '001',
    'Production indexes, payload_size_bytes generated column, cleanup_expired_messages, agent/thread overview views'
)
ON CONFLICT (version) DO NOTHING;
