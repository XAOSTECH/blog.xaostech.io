-- Blog Posts Table
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL,
  excerpt TEXT,
  featured_image_url TEXT,
  status TEXT DEFAULT 'draft', -- draft | published
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- Message Wall (posts with multiple comments displayed inline)
CREATE TABLE IF NOT EXISTS message_walls (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Comments (for both posts and walls)
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  post_id TEXT,
  wall_id TEXT,
  parent_comment_id TEXT,
  audio_url TEXT,
  image_url TEXT,
  status TEXT DEFAULT 'approved', -- approved | pending | spam
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (wall_id) REFERENCES message_walls(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- Media Metadata (track file usage for quota)
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL, -- image | audio | video
  r2_key TEXT NOT NULL UNIQUE,
  post_id TEXT,
  comment_id TEXT,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE SET NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

-- Usage Quota Tracking
CREATE TABLE IF NOT EXISTS usage_quota (
  user_id TEXT PRIMARY KEY,
  total_bytes_used INTEGER DEFAULT 0,
  total_files INTEGER DEFAULT 0,
  reset_date INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_wall ON comments(wall_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
CREATE INDEX IF NOT EXISTS idx_media_comment ON media(comment_id);
