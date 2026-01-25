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
  vite: {
    define: {
      'process.env': {},
    },
  },
});
