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

export const GET: APIRoute = async ({ params, locals }) => {
  const { slug } = params;
  return proxyToAPI(locals, `/blog/posts/${slug}`);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const { slug } = params;

  if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();
  const cookies = request.headers.get('Cookie') || '';

  return proxyToAPI(locals, `/blog/posts/${slug}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies,
      'X-User-Id': user.id,
    },
    body,
  });
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const { slug } = params;

  if (!user || user.role !== 'owner') {
    return new Response(JSON.stringify({ error: 'Owner access required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cookies = request.headers.get('Cookie') || '';

  return proxyToAPI(locals, `/blog/posts/${slug}`, {
    method: 'DELETE',
    headers: {
      'Cookie': cookies,
      'X-User-Id': user.id,
    },
  });
};
