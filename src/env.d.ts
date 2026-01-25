/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SESSIONS_KV: KVNamespace;
  MAX_FILE_SIZE: string;
  ADMIN_ROLE: string;
  FREE_TIER_LIMIT_GB: string;
  CACHE_TTL: string;
  API_ACCESS_CLIENT_ID?: string;
  API_ACCESS_CLIENT_SECRET?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    user: User | null;
  }
}

interface User {
  id: string;
  userId?: string;
  email: string;
  username?: string;
  role: string;
  avatar_url?: string;
  github_id?: string;
  account_id?: string;
}
