import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;
  const db = runtime?.env?.DB;

  if (!db) {
    return new Response(JSON.stringify({ error: 'Database unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await db.prepare(`
      SELECT p.id, p.title, p.slug, p.excerpt, p.featured_image_url, p.published_at, p.status,
             u.username as author_name, u.avatar_url as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.status = 'published'
      ORDER BY p.published_at DESC
      LIMIT 50
    `).all();

    return new Response(JSON.stringify({ posts: result.results || [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('API Error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const runtime = locals.runtime;
  const db = runtime?.env?.DB;

  // Auth check
  if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!db) {
    return new Response(JSON.stringify({ error: 'Database unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { title, content, excerpt, featured_image_url, status } = body;

    if (!title || !content) {
      return new Response(JSON.stringify({ error: 'Title and content required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate slug
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existing = await db.prepare(
      'SELECT COUNT(*) as count FROM posts WHERE slug LIKE ?'
    ).bind(`${baseSlug}%`).first<{ count: number }>();

    const slug = existing?.count ? `${baseSlug}-${existing.count + 1}` : baseSlug;

    const now = Math.floor(Date.now() / 1000);
    const publishedAt = status === 'published' ? now : null;

    const result = await db.prepare(`
      INSERT INTO posts (title, slug, content, excerpt, featured_image_url, author_id, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      title,
      slug,
      content,
      excerpt || '',
      featured_image_url || null,
      user.id,
      status || 'draft',
      publishedAt,
      now,
      now
    ).run();

    return new Response(JSON.stringify({ 
      success: true, 
      slug,
      id: result.meta?.last_row_id 
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('API Error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
