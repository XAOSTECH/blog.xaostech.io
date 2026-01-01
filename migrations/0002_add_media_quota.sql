-- Track user storage quota for R2 media
CREATE TABLE IF NOT EXISTS user_quota (
  user_id TEXT PRIMARY KEY,
  used_gb REAL DEFAULT 0,
  limit_gb INTEGER DEFAULT 10,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Track individual media file uploads for listing
CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  type TEXT NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY(user_id) REFERENCES users(id),
  UNIQUE(user_id, key)
);

CREATE INDEX idx_media_files_user_id ON media_files(user_id, uploaded_at DESC);
CREATE INDEX idx_media_files_deleted ON media_files(deleted_at);
