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
  // Astro emits Content-Security-Policy with hashed inline <script> blocks.
  // Hand-rolled CSP from shared/types/security.ts is now skipped in middleware.
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self' https:",
        "connect-src 'self' https: wss:",
        "img-src 'self' data: https:",
        "font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "require-trusted-types-for 'script'"
      ],
      styleDirective: {
        resources: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https:']
      }
    }
  },
  vite: {
    define: {
      'process.env': {},
    },
  },
});
