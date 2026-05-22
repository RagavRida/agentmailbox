-- ============================================================================
-- Migration 003: GitHub OAuth fields on users
-- ============================================================================
-- Adds the minimum columns the OAuth callback needs to find or link a user:
--   * github_id     — numeric id from GitHub (stable across renames). UNIQUE.
--   * github_login  — current GitHub username (may change; informational).
--   * avatar_url    — displayed in the dashboard nav.
--
-- Pre-existing rows (email-only signups) are untouched. The OAuth callback
-- first matches by github_id, then falls back to matching by email so an
-- email-signup account gets linked to GitHub on first OAuth login.
-- ============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS github_id BIGINT UNIQUE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS github_login TEXT;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_url TEXT;

CREATE INDEX IF NOT EXISTS idx_users_github_id
    ON users(github_id)
    WHERE github_id IS NOT NULL;

INSERT INTO schema_migrations (version, description)
VALUES ('003', 'GitHub OAuth fields on users (github_id, github_login, avatar_url)')
ON CONFLICT (version) DO NOTHING;
