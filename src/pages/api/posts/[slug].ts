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

export const GET: APIRoute = async ({ params, locals }) => {
  const { slug } = params;
  return proxyToAPI(`/blog/posts/${slug}`);
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

  return proxyToAPI(`/blog/posts/${slug}`, {
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

  return proxyToAPI(`/blog/posts/${slug}`, {
    method: 'DELETE',
    headers: {
      'Cookie': cookies,
      'X-User-Id': user.id,
    },
  });
};
