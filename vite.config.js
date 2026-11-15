import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative base so the built site works from any folder or GitHub Pages.
  base: './',
  server: { host: true },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        survey: resolve(import.meta.dirname, 'survey.html'),
      },
    },
  },
});
