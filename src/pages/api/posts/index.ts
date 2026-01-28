import type { APIRoute } from 'astro';

// Helper to proxy requests to the central API using external fetch
const proxyToAPI = async (locals: any, path: string, init?: RequestInit) => {
  const env = locals.runtime?.env || {};
  const clientId = env.API_ACCESS_CLIENT_ID;
  const clientSecret = env.API_ACCESS_CLIENT_SECRET;

  try {
    const url = `https://api.xaostech.io${path}`;
    const headers = new Headers(init?.headers || {});

    if (clientId && clientSecret) {
      headers.set('CF-Access-Client-Id', clientId);
      headers.set('CF-Access-Client-Secret', clientSecret);
    }

    const resp = await fetch(url, { ...init, headers });
    return resp;
  } catch (e: any) {
    console.error('API proxy error:', e);
    return new Response(JSON.stringify({ error: 'API proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const GET: APIRoute = async ({ url, locals }) => {
  const limit = url.searchParams.get('limit') || '50';
  return proxyToAPI(locals, `/blog/posts?limit=${limit}`);
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

  return proxyToAPI(locals, '/blog/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies,
      'X-User-Id': user.id,
    },
    body,
  });
};
