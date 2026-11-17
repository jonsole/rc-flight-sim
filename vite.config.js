import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';

// Each site file's size (bytes), for its loading percentage when the server
// sends it compressed (and so doesn't say how big it is).
function siteSizes() {
  const dir = resolve(import.meta.dirname, 'src/locations');
  const out = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = statSync(resolve(dir, f)).size;
  return out;
}

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
  define: { __VERSION__: JSON.stringify(gitVersion()), __SITE_SIZES__: JSON.stringify(siteSizes()) },
  server: { host: true },
  build: {
    // (Top-level await: main.js waits for the world to be built.)
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        survey: resolve(import.meta.dirname, 'survey.html'),
      },
    },
  },
});
