/// <reference types="@cloudflare/workers-types" />
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { createApiProxyRoute } from '../shared/types/api-proxy-hono';
import { serveFaviconHono } from '../shared/types/favicon';
import { applySecurityHeaders } from '../shared/types/security';

// API Worker URL for cross-service calls
const API_WORKER_URL = 'https://api.xaostech.io';

// Types
interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  MAX_FILE_SIZE: string;
  ADMIN_ROLE: string;
  FREE_TIER_LIMIT_GB: string;
  CACHE_TTL: string;
  // Auth token for API proxy
  API_ACCESS_CLIENT_ID?: string;
  API_ACCESS_CLIENT_SECRET?: string;
  // Backwards compatibility
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

interface User {
  id: string;
  email: string;
  role: string;
  account_id: string;
}

// Hono context variables
type Variables = {
  user: User | null;
};

// Helper to safely cast status codes for Hono's strict typing
// Returns 500 for informational (1xx) and other non-contentful statuses
const asStatus = (status: number): ContentfulStatusCode =>
  (status >= 200 ? status : 500) as ContentfulStatusCode;

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

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global security headers middleware
app.use('*', async (c, next) => {
  await next();
  const res = c.res as Response;
  return applySecurityHeaders(res);
});

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

// === PROXY DEBUG TEST ===
app.get('/debug/proxy-test', async (c: any) => {
  try {
    const url = new URL('/api/debug/headers', c.req.url);
    const resp = await fetch(url.toString(), { method: 'GET' });
    const json = await resp.json();
    return c.json({ proxied: json });
  } catch (err: any) {
    console.error('Proxy test error:', err);
    return c.json({ error: 'Proxy test failed' }, 500);
  }
});

// === LOCAL ENV PRESENCE CHECK ===
// Returns whether this worker has CF_ACCESS secrets available at runtime (no secret values returned)
app.get('/debug/env', (c: any) => {
  const cEnvHasApiClientId = !!(c.env && c.env.API_ACCESS_CLIENT_ID);
  const cEnvHasApiClientSecret = !!(c.env && c.env.API_ACCESS_CLIENT_SECRET);
  return c.json({ cEnvHasApiClientId, cEnvHasApiClientSecret });
});

// ============ API PROXY ============
// Routes /api/* requests to api.xaostech.io with API_ACCESS authentication
app.all('/api/*', createApiProxyRoute());

// ============ FAVICON ============
// Favicon proxied through local /api/data/assets route
app.get('/favicon.ico', serveFaviconHono);

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

// POST /upload - Upload media (proxied through API worker to data worker)
app.post('/upload', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const targetId = formData.get('target_id') as string;
    const targetType = formData.get('target_type') as string;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const maxSize = parseInt(c.env.MAX_FILE_SIZE);
    if (file.size > maxSize) {
      return c.json({ error: 'File too large' }, 413);
    }

    // Check quota before proxying
    const quota = await c.env.DB.prepare(
      'SELECT total_bytes_used FROM usage_quota WHERE user_id = ?'
    ).bind(user.id).first<{ total_bytes_used: number }>();

    const used = quota?.total_bytes_used || 0;
    const limit = parseInt(c.env.FREE_TIER_LIMIT_GB) * 1024 * 1024 * 1024;

    if (used + file.size > limit) {
      return c.json({ error: 'Quota exceeded' }, 429);
    }

    // Proxy upload to local /api/data/blog-media which routes through API worker to data worker
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('userId', user.id);
    uploadFormData.append('bucket', 'blog-media');
    uploadFormData.append('targetId', targetId);
    uploadFormData.append('targetType', targetType);

    const response = await fetch('/api/data/blog-media/upload', {
      method: 'POST',
      headers: {
        'X-User-ID': user.id,
        'X-User-Role': user.role,
        'X-User-Email': user.email,
        'X-Account-ID': user.account_id,
      },
      body: uploadFormData,
    });

    if (!response.ok) {
      return c.json({ error: 'Upload failed' }, asStatus(response.status));
    }

    const result = await response.json();

    // Record metadata locally
    const mediaId = result.mediaId || crypto.randomUUID();
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
      result.r2_key,
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

    return c.json({ 
      mediaId, 
      url: result.url,
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

// ===== MEDIA STORAGE (Centralized via API → Data Worker) =====
// Blog worker delegates all media operations through api.xaostech.io
// This keeps all API logic centralized and allows rate limiting/auth in API
// See: api.xaostech.io/blog-media/* endpoints



// GET /media/quota - Check user storage quota (proxied via API to data worker)
app.get('/media/quota', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const headers = new Headers();
    const clientId = c.env.API_ACCESS_CLIENT_ID;
    const clientSecret = c.env.API_ACCESS_CLIENT_SECRET;
    if (clientId && clientSecret) {
      headers.set('CF-Access-Client-Id', clientId);
      headers.set('CF-Access-Client-Secret', clientSecret);
    }
    const response = await fetch(`${API_WORKER_URL}/data/blog-media/quota/${user.id}`, { headers });
    const data = await response.json();
    return c.json(data, asStatus(response.status));
  } catch (err) {
    console.error('Quota fetch error:', err);
    return c.json({ error: 'Failed to fetch quota' }, 500);
  }
});

// POST /media/upload - Upload image/audio (proxied via API to data worker)
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

    // Forward to API worker with user_id
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('user_id', user.id);

    const headers = new Headers();
    headers.set('X-User-ID', user.id);
    // POST to local API proxy so API_ACCESS_* headers are injected at runtime
    const response = await fetch('/api/data/blog-media/upload', {
      method: 'POST',
      body: uploadFormData,
      headers
    });

    const data = await response.json();
    return c.json(data, asStatus(response.status));
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

    // Forward to API via local proxy so API_ACCESS_* headers are injected at runtime
    const headers = new Headers();
    headers.set('X-User-ID', user.id);
    const response = await fetch(`/api/data/blog-media/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers
    });

    const data = await response.json();
    return c.json(data, asStatus(response.status));
  } catch (e) {
    console.error('Media delete error:', e);
    return c.json({ error: 'Delete failed' }, 500);
  }
});

// GET /media/list - List user's uploaded files (proxied via API to data worker)
app.get('/media/list', async (c) => {
  const user = c.get('user') as User | undefined;
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const headers = new Headers();
    // Call local API proxy so API_ACCESS_* headers are injected at runtime
    const response = await fetch(`/api/data/blog-media/quota/${user.id}`, { headers });
    const data = await response.json();
    return c.json(data, asStatus(response.status));
  } catch (e) {
    console.error('Media list error:', e);
    return c.json({ error: 'List failed' }, 500);
  }
});

// GET /favicon.ico - Serve favicon
app.get('/favicon.ico', serveFaviconHono);

// ============ LANDING PAGE ============
app.get('/', async (c) => {
  // Fetch recent posts
  let posts: any[] = [];
  try {
    const result = await c.env.DB.prepare(
      `SELECT p.id, p.title, p.slug, p.excerpt, p.featured_image_url, p.published_at, p.author_id,
              u.username as author_name, u.avatar_url as author_avatar
       FROM posts p
       LEFT JOIN users u ON p.author_id = u.id
       WHERE p.status = 'published'
       ORDER BY p.published_at DESC
       LIMIT 5`
    ).all();
    posts = result.results || [];
  } catch (e) {
    console.error('Failed to fetch posts:', e);
  }

  const postsHtml = posts.length > 0 ? posts.map((p: any) => {
    const img = p.featured_image_url ? '<img src="' + p.featured_image_url + '" alt="' + p.title + '" class="post-image">' : '';
    const author = p.author_name || 'Author';
    const avatar = p.author_avatar || '/api/data/assets/XAOSTECH_LOGO.png';
    const date = p.published_at ? new Date(p.published_at * 1000).toLocaleDateString() : '';
    return '<article class="post-card">' + img + '<div class="post-content"><h2><a href="/posts/' + p.slug + '">' + p.title + '</a></h2><p class="excerpt">' + (p.excerpt || '') + '</p><div class="post-meta"><div class="author"><img src="' + avatar + '" alt="' + author + '" class="author-avatar"><span>' + author + '</span></div><time>' + date + '</time></div></div></article>';
  }).join('') : '<p class="no-posts">No posts yet. Check back soon!</p>';

  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>XAOSTECH Blog</title><link rel="icon" type="image/png" href="/api/data/assets/XAOSTECH_LOGO.png"><style>:root { --primary: #f6821f; --bg: #0a0a0a; --text: #e0e0e0; --card-bg: #1a1a1a; } * { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 2rem; } .container { max-width: 900px; margin: 0 auto; } header { text-align: center; margin-bottom: 3rem; } header h1 { color: var(--primary); font-size: 2.5rem; margin-bottom: 0.5rem; } header p { opacity: 0.7; } .posts { display: flex; flex-direction: column; gap: 2rem; } .post-card { background: var(--card-bg); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; } .post-image { width: 100%; height: 200px; object-fit: cover; } .post-content { padding: 1.5rem; } .post-content h2 { margin-bottom: 0.75rem; } .post-content h2 a { color: var(--text); text-decoration: none; } .post-content h2 a:hover { color: var(--primary); } .excerpt { opacity: 0.8; margin-bottom: 1rem; line-height: 1.6; } .post-meta { display: flex; justify-content: space-between; align-items: center; opacity: 0.6; font-size: 0.9rem; } .author { display: flex; align-items: center; gap: 0.5rem; } .author-avatar { width: 28px; height: 28px; border-radius: 50%; } .no-posts { text-align: center; opacity: 0.6; padding: 3rem; } footer { text-align: center; margin-top: 4rem; opacity: 0.5; font-size: 0.85rem; } footer a { color: var(--primary); } @media (min-width: 600px) { .post-card { flex-direction: row; } .post-image { width: 300px; height: auto; min-height: 180px; } }</style></head><body><div class="container"><header><h1>📝 XAOSTECH Blog</h1><p>Thoughts, tutorials, and updates from the XAOSTECH team</p></header><section class="posts">' + postsHtml + '</section></div><footer><a href="https://xaostech.io">← Back to XAOSTECH</a></footer></body></html>';
  return c.html(html);
});

export default app;
