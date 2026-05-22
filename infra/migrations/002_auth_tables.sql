-- ============================================================================
-- Migration 002: per-user API keys + multi-tenant scoping
-- ============================================================================
-- Adds the minimum tables needed for cloud-tier auth + tenant isolation:
--   * users      — one row per signup (no billing fields; Stripe wiring is
--                  intentionally deferred until we actually have an account)
--   * api_keys   — hashed bearer tokens scoped to a user
--   * plan_limits— reference table with hard caps per plan name
--
-- Also retrofits user_id onto agents + threads so the existing storage rows
-- can be re-keyed when self-hosted data gets migrated to a cloud tenant.
-- Both columns are nullable — NULL user_id == "self-hosted-style row" — so
-- existing data is untouched and the Postgres adapter keeps working in
-- non-CLOUD_MODE deployments.
-- ============================================================================


-- ---------- 1. extensions ----------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";       -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";        -- gen_random_bytes(), if needed later


-- ---------- 2. users ----------
-- No billing fields. `plan` is just a key into plan_limits; every signup
-- gets 'free' and stays there until we add an upgrade flow.

CREATE TABLE IF NOT EXISTS users (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       TEXT        UNIQUE NOT NULL,
    name        TEXT,
    plan        TEXT        NOT NULL DEFAULT 'free'
                            CHECK (plan IN ('free','pro','team','enterprise')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);


-- ---------- 3. api_keys ----------
-- We store SHA-256 of the full key, plus a `prefix` (first ~16 chars) so the
-- UI can show "sk_live_abcd…" without ever holding the secret. The raw key is
-- returned exactly once at creation time.

CREATE TABLE IF NOT EXISTS api_keys (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash      TEXT        NOT NULL UNIQUE,         -- SHA-256 hex of full key
    key_prefix    TEXT        NOT NULL,                -- "sk_live_XXXXXXXX"
    name          TEXT        NOT NULL DEFAULT 'default',
    scopes        TEXT[]      NOT NULL DEFAULT '{all}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,                         -- NULL = never expires
    revoked_at    TIMESTAMPTZ                          -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user
    ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
    ON api_keys(key_prefix);


-- ---------- 4. plan_limits (reference data) ----------
-- Soft caps enforced at the application layer in src/cloud/middleware.ts.
-- -1 == unlimited.

CREATE TABLE IF NOT EXISTS plan_limits (
    plan                   TEXT    PRIMARY KEY,
    max_agents             INTEGER NOT NULL,
    max_messages_per_day   INTEGER NOT NULL,
    max_threads            INTEGER NOT NULL,
    max_payload_bytes      INTEGER NOT NULL,
    max_api_keys           INTEGER NOT NULL,
    retention_days         INTEGER NOT NULL,
    compression_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    webhooks_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    priority_support       BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO plan_limits VALUES
    ('free',        10,    500,    100,   65536,   2,    7, FALSE, FALSE, FALSE),
    ('pro',         50,  10000,   1000,  262144,  10,   30,  TRUE,  TRUE, FALSE),
    ('team',       200, 100000,  10000, 1048576,  50,   90,  TRUE,  TRUE,  TRUE),
    ('enterprise',  -1,     -1,     -1,      -1,  -1,   -1,  TRUE,  TRUE,  TRUE)
ON CONFLICT (plan) DO NOTHING;


-- ---------- 5. usage_metrics ----------
-- Per-user per-day counters. Rate limiting middleware reads this; the post-
-- success path increments it via UPSERT.

CREATE TABLE IF NOT EXISTS usage_metrics (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric        TEXT        NOT NULL,
                              -- 'messages_sent', 'agents_registered', 'api_calls'
    count         BIGINT      NOT NULL DEFAULT 0,
    period_start  DATE        NOT NULL,
    UNIQUE (user_id, metric, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_lookup
    ON usage_metrics(user_id, metric, period_start);


-- ---------- 6. retrofit user_id onto agents + threads ----------
-- Nullable columns: NULL == no tenant (self-hosted-style row). Cloud-tier
-- middleware always sets a value; self-hosted leaves it NULL.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE threads
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_agents_user
    ON agents(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_threads_user
    ON threads(user_id) WHERE user_id IS NOT NULL;


-- ---------- 7. record migration ----------

INSERT INTO schema_migrations (version, description)
VALUES (
    '002',
    'Per-user API keys + multi-tenant scoping (users, api_keys, plan_limits, usage_metrics, user_id on agents/threads)'
)
ON CONFLICT (version) DO NOTHING;
