-- Users table for blog (synced from account/api workers)
-- This allows efficient JOINs for author info without cross-worker calls

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  username TEXT,
  email TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'user', -- user | admin | owner
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
