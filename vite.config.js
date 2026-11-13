import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any folder or GitHub Pages.
  base: './',
  server: { host: true },
  build: { chunkSizeWarningLimit: 1000 },
});
