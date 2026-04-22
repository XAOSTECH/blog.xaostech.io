import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';

// Helper to proxy requests to the central API
const proxyToAPI = async (path: string, init?: RequestInit) => {
  const api = (cfEnv as { API?: { fetch: typeof fetch } }).API;
  if (!api) {
    return new Response(JSON.stringify({ error: 'API service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const resp = await api.fetch(`https://api.xaostech.io${path}`, init);
    return resp;
  } catch (e: any) {
    console.error('API proxy error:', e);
    return new Response(JSON.stringify({ error: 'API proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const GET: APIRoute = async ({ url }) => {
  const limit = url.searchParams.get('limit') || '50';
  return proxyToAPI(`/blog/posts?limit=${limit}`);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;

  // Auth check
  if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();

  // Get session token to forward auth
  const cookies = request.headers.get('Cookie') || '';

  return proxyToAPI('/blog/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies,
      'X-User-Id': user.id,
    },
    body,
  });
};
