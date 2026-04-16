import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    host: true, 
    port: 4321,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 4321,
    },
  },
  vite: {
    server: {
      watch: {
        usePolling: true,
        interval: 100,
      },
    },

    plugins: [tailwindcss()],
  },
});