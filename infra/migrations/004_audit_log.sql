-- ============================================================================
-- Migration 004: audit log table
-- ============================================================================
-- Adds the audit_log table to record user actions such as:
--   * key.create, key.revoke
--   * agent.register
--   * thread.create
--   * message.send, message.receive, message.read
--   * auth.login, auth.fail
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
    agent_id        TEXT,
    action          TEXT        NOT NULL,
                                -- 'agent.register', 'message.send', 'message.receive',
                                -- 'thread.create', 'key.create', 'key.revoke',
                                -- 'auth.login', 'auth.fail', 'plan.upgrade'
    resource_type   TEXT,       -- 'agent', 'thread', 'message', 'api_key'
    resource_id     TEXT,       -- the id of the affected resource
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user
    ON audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON audit_log(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource
    ON audit_log(resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
    ON audit_log(created_at);

-- Record the migration
INSERT INTO schema_migrations (version, description)
VALUES (
    '004',
    'Create audit_log table and indexes for user activity logging'
)
ON CONFLICT (version) DO NOTHING;
