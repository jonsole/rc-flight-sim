import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// The commit being built (shown on the start page), if git is there.
function gitVersion() {
  try {
    const [sha, date] = execSync('git log -1 --format=%H%n%cI', { encoding: 'utf8' }).trim().split('\n');
    return { sha, date };
  } catch {
    return { sha: '', date: '' };
  }
}

export default defineConfig({
  // Relative base so the built site works from any folder or GitHub Pages.
  base: './',
  define: { __VERSION__: JSON.stringify(gitVersion()) },
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
