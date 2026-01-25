import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ params, locals }) => {
  const runtime = locals.runtime;
  const db = runtime?.env?.DB;
  const { slug } = params;

  if (!db) {
    return new Response(JSON.stringify({ error: 'Database unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const post = await db.prepare(`
      SELECT p.*, u.username as author_name, u.avatar_url as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.slug = ? AND p.status = 'published'
    `).bind(slug).first();

    if (!post) {
      return new Response(JSON.stringify({ error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get comments
    const commentsResult = await db.prepare(`
      SELECT id, content, author_name, image_url, audio_url, created_at, status
      FROM comments WHERE post_id = ? AND status = 'approved'
      ORDER BY created_at DESC
    `).bind(post.id).all();

    return new Response(JSON.stringify({ 
      post, 
      comments: commentsResult.results || [] 
    }), {
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

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const runtime = locals.runtime;
  const db = runtime?.env?.DB;
  const { slug } = params;

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
    const post = await db.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
    
    if (!post) {
      return new Response(JSON.stringify({ error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json();
    const { title, content, excerpt, featured_image_url, status } = body;

    const now = Math.floor(Date.now() / 1000);
    let publishedAt = post.published_at;
    
    // Set published_at if publishing for the first time
    if (status === 'published' && !publishedAt) {
      publishedAt = now;
    }

    await db.prepare(`
      UPDATE posts 
      SET title = ?, content = ?, excerpt = ?, featured_image_url = ?, status = ?, published_at = ?, updated_at = ?
      WHERE slug = ?
    `).bind(
      title || post.title,
      content || post.content,
      excerpt ?? post.excerpt,
      featured_image_url ?? post.featured_image_url,
      status || post.status,
      publishedAt,
      now,
      slug
    ).run();

    return new Response(JSON.stringify({ success: true }), {
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

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const runtime = locals.runtime;
  const db = runtime?.env?.DB;
  const { slug } = params;

  if (!user || user.role !== 'owner') {
    return new Response(JSON.stringify({ error: 'Owner access required' }), {
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
    await db.prepare('DELETE FROM posts WHERE slug = ?').bind(slug).run();

    return new Response(JSON.stringify({ success: true }), {
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
