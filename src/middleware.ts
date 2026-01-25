import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
  const { cookies, locals } = context;
  
  // Skip session check for API routes and static assets
  const path = new URL(context.request.url).pathname;
  if (path.startsWith('/api/') || path.includes('.')) {
    return next();
  }

  // Get runtime from Cloudflare
  const runtime = locals.runtime;
  if (!runtime?.env?.SESSIONS_KV) {
    locals.user = null;
    return next();
  }

  // Parse session from cookie
  const sessionId = cookies.get('session_id')?.value;
  
  if (sessionId) {
    try {
      const sessionData = await runtime.env.SESSIONS_KV.get(sessionId);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        // Check session hasn't expired
        if (!session.expires || session.expires > Date.now()) {
          locals.user = {
            id: session.userId || session.id,
            userId: session.userId || session.id,
            email: session.email || '',
            username: session.username,
            role: session.role || 'user',
            avatar_url: session.avatar_url,
            github_id: session.github_id,
          };
          
          // Sync user to local blog-db (fire and forget)
          try {
            await runtime.env.DB.prepare(`
              INSERT INTO users (id, github_id, username, email, avatar_url, role, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, unixepoch())
              ON CONFLICT(id) DO UPDATE SET
                username = excluded.username,
                email = excluded.email,
                avatar_url = excluded.avatar_url,
                role = excluded.role,
                updated_at = unixepoch()
            `).bind(
              locals.user.id,
              locals.user.github_id || null,
              locals.user.username || null,
              locals.user.email || null,
              locals.user.avatar_url || null,
              locals.user.role
            ).run();
          } catch {
            // Ignore sync errors - table may not exist yet
          }
          
          return next();
        }
      }
    } catch (e) {
      console.error('Session verification failed:', e);
    }
  }
  
  locals.user = null;
  return next();
});
