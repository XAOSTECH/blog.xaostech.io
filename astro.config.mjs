import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
    routes: {
      extend: {
        include: [{ pattern: '/api/*' }],
      },
    },
  }),
  // CSP is emitted from src/middleware.ts (single source of truth).
  // See shared/types/security.ts for why Astro's security.csp was removed.
  vite: {
    define: {
      'process.env': {},
    },
  },
});
