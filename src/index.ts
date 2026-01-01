import { Hono } from 'hono';
import { z } from 'zod';

// Types
interface Env {
  DB: D1Database;
  BLOG_MEDIA: R2Bucket;
  CACHE: KVNamespace;
  MAX_FILE_SIZE: string;
  ADMIN_ROLE: string;
  FREE_TIER_LIMIT_GB: string;
  CACHE_TTL: string;
}

interface User {
  id: string;
  email: string;
  role: string;
  account_id: string;
}

// Validation schemas
const PostSchema = z.object({
  title: z.string().min(3).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  content: z.string().min(10),
  excerpt: z.string().max(300).optional(),
});

const CommentSchema = z.object({
  content: z.string().min(1).max(5000),
  author_name: z.string().optional(),
  parent_comment_id: z.string().optional(),
});

const WallSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(500).optional(),
});

const app = new Hono<{ Bindings: Env }>();

// Middleware to get user from account worker
app.use('*', async (c, next) => {
  const sessionId = c.req.header('Cookie')?.split('session=')[1]?.split(';')[0];
  
  if (sessionId && c.req.path !== '/health') {
    try {
      // In production, fetch user from account.xaostech.io
      // For now, extract from header (injected by reverse proxy)
      const userId = c.req.header('X-User-ID');
      const userRole = c.req.header('X-User-Role');
      
      if (userId) {
        c.set('user', { 
          id: userId, 
          role: userRole || 'user',
          email: c.req.header('X-User-Email') || '',
          account_id: c.req.header('X-Account-ID') || ''
        });
      }
    } catch (e) {
      console.error('Auth check failed:', e);
    }
  }
  
  await next();
});

// ============ HEALTH CHECK ============
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'blog' });
});

// ============ BLOG POSTS ENDPOINTS ============

// GET /posts - List all published posts (paginated)
app.get('/posts', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = (page - 1) * limit;

  const cached = await c.env.CACHE.get(`posts:page:${page}`);
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const result = await c.env.DB.prepare(
    `SELECT id, title, slug, excerpt, featured_image_url, published_at, author_id
     FROM posts WHERE status = 'published'
     ORDER BY published_at DESC
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM posts WHERE status = "published"'
  ).first<{ total: number }>();

  const response = {
    posts: result.results,
    total: count?.total || 0,
    page,
    pages: Math.ceil((count?.total || 0) / limit)
  };

  await c.env.CACHE.put(
    `posts:page:${page}`,
    JSON.stringify(response),
    { expirationTtl: parseInt(c.env.CACHE_TTL) }
  );

  return c.json(response);
});

// GET /posts/:slug - Get single post with comments
app.get('/posts/:slug', async (c) => {
  const slug = c.req.param('slug');

  const cached = await c.env.CACHE.get(`post:${slug}`);
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const post = await c.env.DB.prepare(
    'SELECT * FROM posts WHERE slug = ? AND status = "published"'
  ).bind(slug).first();

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  const comments = await c.env.DB.prepare(
    `SELECT id, content, author_name, image_url, audio_url, created_at, status
     FROM comments WHERE post_id = ? AND status = 'approved'
     ORDER BY created_at DESC`
  ).bind(post.id).all();

  const response = { post, comments: comments.results };
  
  await c.env.CACHE.put(
    `post:${slug}`,
    JSON.stringify(response),
    { expirationTtl: parseInt(c.env.CACHE_TTL) }
  );

  return c.json(response);
});

// POST /posts - Create new post (admin only)
app.post('/posts', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  try {
    const data = await c.req.json();
    const validated = PostSchema.parse(data);

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO posts (id, title, slug, content, excerpt, author_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(
      id,
      validated.title,
      validated.slug,
      validated.content,
      validated.excerpt || '',
      user.id,
      now,
      now
    ).run();

    await c.env.CACHE.delete(`posts:page:1`); // Invalidate cache

    return c.json({ id, ...validated }, 201);
  } catch (e) {
    return c.json({ error: 'Invalid post data' }, 400);
  }
});

// PUT /posts/:id - Update post (admin only)
app.put('/posts/:id', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const id = c.req.param('id');
  
  try {
    const data = await c.req.json();
    const validated = PostSchema.partial().parse(data);
    const now = Math.floor(Date.now() / 1000);

    const updates = Object.entries(validated)
      .map(([key]) => `${key} = ?`)
      .join(', ');

    const values = [...Object.values(validated), now, id];

    await c.env.DB.prepare(
      `UPDATE posts SET ${updates}, updated_at = ? WHERE id = ? AND author_id = ?`
    ).bind(...values, user.id).run();

    return c.json({ id, ...validated });
  } catch (e) {
    return c.json({ error: 'Invalid update data' }, 400);
  }
});

// POST /posts/:id/publish - Publish a draft post
app.post('/posts/:id/publish', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `UPDATE posts SET status = 'published', published_at = ?, updated_at = ? 
     WHERE id = ? AND author_id = ?`
  ).bind(now, now, id, user.id).run();

  await c.env.CACHE.delete(`posts:page:1`);

  return c.json({ id, status: 'published' });
});

// ============ MESSAGE WALL ENDPOINTS ============

// GET /walls - List message walls
app.get('/walls', async (c) => {
  const walls = await c.env.DB.prepare(
    'SELECT id, title, description, created_at FROM message_walls WHERE is_active = 1'
  ).all();

  return c.json({ walls: walls.results });
});

// GET /walls/:id - Get wall with comments in comment bubbles
app.get('/walls/:id', async (c) => {
  const wallId = c.req.param('id');

  const wall = await c.env.DB.prepare(
    'SELECT id, title, description FROM message_walls WHERE id = ?'
  ).bind(wallId).first();

  if (!wall) {
    return c.json({ error: 'Wall not found' }, 404);
  }

  const comments = await c.env.DB.prepare(
    `SELECT id, content, author_name, image_url, audio_url, created_at, 
            (SELECT COUNT(*) FROM comments c2 WHERE c2.parent_comment_id = comments.id) as reply_count
     FROM comments WHERE wall_id = ? AND parent_comment_id IS NULL AND status = 'approved'
     ORDER BY created_at DESC`
  ).bind(wallId).all();

  return c.json({
    wall,
    messages: comments.results,
    total_comments: comments.results.length
  });
});

// POST /walls/:id/comments - Add comment to wall or post
app.post('/walls/:id/comments', async (c) => {
  const wallId = c.req.param('id');
  
  try {
    const data = await c.req.json();
    const validated = CommentSchema.parse(data);
    
    const user = c.get('user') as User | undefined;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const status = user && user.role === c.env.ADMIN_ROLE ? 'approved' : 'pending';

    await c.env.DB.prepare(
      `INSERT INTO comments (id, content, author_id, author_name, wall_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      validated.content,
      user?.id || null,
      validated.author_name || 'Anonymous',
      wallId,
      status,
      now,
      now
    ).run();

    return c.json({ id, ...validated, status }, 201);
  } catch (e) {
    return c.json({ error: 'Invalid comment data' }, 400);
  }
});

// ============ MEDIA UPLOAD ENDPOINT ============

// POST /upload - Upload media to R2
app.post('/upload', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const targetId = formData.get('target_id') as string; // post_id or comment_id
    const targetType = formData.get('target_type') as string; // 'post' or 'comment'

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const maxSize = parseInt(c.env.MAX_FILE_SIZE);
    if (file.size > maxSize) {
      return c.json({ error: 'File too large' }, 413);
    }

    // Check quota
    const quota = await c.env.DB.prepare(
      'SELECT total_bytes_used FROM usage_quota WHERE user_id = ?'
    ).bind(user.id).first<{ total_bytes_used: number }>();

    const used = quota?.total_bytes_used || 0;
    const limit = parseInt(c.env.FREE_TIER_LIMIT_GB) * 1024 * 1024 * 1024;

    if (used + file.size > limit) {
      return c.json({ error: 'Quota exceeded' }, 429);
    }

    // Upload to R2
    const fileKey = `${user.id}/${Date.now()}-${file.name}`;
    const buffer = await file.arrayBuffer();
    
    await c.env.BLOG_MEDIA.put(fileKey, buffer);

    // Record metadata
    const mediaId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const fileType = file.type.startsWith('audio') ? 'audio' 
                   : file.type.startsWith('image') ? 'image' : 'video';

    await c.env.DB.prepare(
      `INSERT INTO media (id, file_name, file_size, file_type, r2_key, post_id, comment_id, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      mediaId,
      file.name,
      file.size,
      fileType,
      fileKey,
      targetType === 'post' ? targetId : null,
      targetType === 'comment' ? targetId : null,
      user.id,
      now
    ).run();

    // Update quota
    await c.env.DB.prepare(
      `INSERT INTO usage_quota (user_id, total_bytes_used, total_files, reset_date)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET 
       total_bytes_used = total_bytes_used + ?, total_files = total_files + 1`
    ).bind(user.id, file.size, now, file.size).run();

    const mediaUrl = `https://blog-media.xaostech.io/${fileKey}`;

    return c.json({ 
      mediaId, 
      url: mediaUrl,
      file_type: fileType,
      file_size: file.size
    }, 201);
  } catch (e) {
    console.error('Upload error:', e);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// ============ ADMIN ENDPOINTS ============

// GET /admin/posts - List all posts (admin)
app.get('/admin/posts', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const posts = await c.env.DB.prepare(
    'SELECT id, title, slug, status, created_at, updated_at FROM posts ORDER BY created_at DESC'
  ).all();

  return c.json({ posts: posts.results });
});

// GET /admin/comments - Moderate pending comments
app.get('/admin/comments', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const comments = await c.env.DB.prepare(
    'SELECT * FROM comments WHERE status = "pending" ORDER BY created_at ASC'
  ).all();

  return c.json({ comments: comments.results });
});

// POST /admin/comments/:id/approve - Approve comment
app.post('/admin/comments/:id/approve', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const id = c.req.param('id');

  await c.env.DB.prepare(
    'UPDATE comments SET status = "approved" WHERE id = ?'
  ).bind(id).run();

  return c.json({ id, status: 'approved' });
});

// DELETE /admin/comments/:id - Delete comment
app.delete('/admin/comments/:id', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user || user.role !== c.env.ADMIN_ROLE) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const id = c.req.param('id');

  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();

  return c.json({ deleted: true });
});

// ===== MEDIA STORAGE (Centralized in data.xaostech.io) =====
// Blog worker delegates all media operations to data worker
// Keeps blog focused on content; data worker handles R2 + quotas
// See: data.xaostech.io/media/* endpoints

const DATA_WORKER_URL = 'https://data.xaostech.io';

// GET /media/quota - Check user storage quota (proxied to data worker)
app.get('/media/quota', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const response = await fetch(`${DATA_WORKER_URL}/media/quota/${user.id}`);
    const data = await response.json();
    return c.json(data, response.status);
  } catch (err) {
    console.error('Quota fetch error:', err);
    return c.json({ error: 'Failed to fetch quota' }, 500);
  }
});

// POST /media/upload - Upload image/audio (proxied to data worker)
app.post('/media/upload', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    // Forward to data worker with user_id
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('user_id', user.id);

    const response = await fetch(`${DATA_WORKER_URL}/media/upload`, {
      method: 'POST',
      body: uploadFormData
    });

    const data = await response.json();
    return c.json(data, response.status);
  } catch (e) {
    console.error('Media upload error:', e);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// DELETE /media/:key - Delete file (proxied to data worker)
app.delete('/media/:key', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const key = decodeURIComponent(c.req.param('key'));

    // Verify file belongs to user (key format: user_id/timestamp-filename)
    if (!key.startsWith(user.id + '/')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Forward to data worker
    const response = await fetch(`${DATA_WORKER_URL}/media/${encodeURIComponent(key)}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    return c.json(data, response.status);
  } catch (e) {
    console.error('Media delete error:', e);
    return c.json({ error: 'Delete failed' }, 500);
  }
});

// GET /media/list - List user's uploaded files (proxied to data worker)
app.get('/media/list', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const response = await fetch(`${DATA_WORKER_URL}/media/list/${user.id}`);
    const data = await response.json();
    return c.json(data, response.status);
  } catch (e) {
    console.error('Media list error:', e);
    return c.json({ error: 'List failed' }, 500);
  }
});

export default app;
