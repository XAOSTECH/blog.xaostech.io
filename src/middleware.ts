import { defineMiddleware, sequence } from 'astro:middleware';
import { applySecurityHeaders } from '../shared/types/security';

const sessionMiddleware = defineMiddleware(async (context, next) => {
  const { cookies, locals } = context;
  const path = new URL(context.request.url).pathname;

  if (path.startsWith('/api/') || path.includes('.')) {
    return next();
  }

  const runtime = locals.runtime;
  if (!runtime?.env?.SESSIONS_KV) {
    locals.user = null;
    return next();
  }

  const sessionId = cookies.get('session_id')?.value;
  if (sessionId) {
    try {
      const sessionData = await runtime.env.SESSIONS_KV.get(sessionId);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        if (!session.expires || session.expires > Date.now()) {
          locals.user = {
            id: session.user_id || session.userId || session.id,
            userId: session.user_id || session.userId || session.id,
            email: session.email || '',
            username: session.username,
            role: session.role || 'user',
            avatar_url: session.avatar_url,
            github_id: session.github_id,
          };
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

const securityMiddleware = defineMiddleware(async (_context, next) => {
  const res = await next();
  return applySecurityHeaders(res);
});

export const onRequest = sequence(sessionMiddleware, securityMiddleware);
