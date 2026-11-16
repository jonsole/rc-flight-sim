// Writes the built-in (drawn-in-code) 3D model of each aircraft as a .glb file
// in src/aircraft/models/, laid out for editing in Blender (see README.md,
// "3D models"). It runs the models in a headless browser.
//
//   node scripts/export-models.mjs                    every aircraft
//   node scripts/export-models.mjs buschtrottel-agro  just these
//
// It overwrites an existing file of the same name: an edited model is lost.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
// Playwright: the project's, or one installed globally (require finds either).
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error(m.text()));
  await page.goto(`${url}package.json`);
  const files = await page.evaluate(async (only) => {
    const { AIRCRAFT } = await import('/src/aircraft/index.js');
    const { exportGlb } = await import('/src/aircraft/exportModel.js');
    const out = {};
    for (const a of AIRCRAFT) {
      if (only.length && !only.includes(a.id)) continue;
      const buf = new Uint8Array(await exportGlb(a));
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out[a.id] = btoa(s);
    }
    return out;
  }, process.argv.slice(2));
  for (const [id, b64] of Object.entries(files)) {
    const path = `${root}src/aircraft/models/${id}.glb`;
    writeFileSync(path, Buffer.from(b64, 'base64'));
    console.log(`${path}  ${(b64.length * 0.75 / 1024).toFixed(0)} kB`);
  }
} finally {
  await browser.close();
  await server.close();
}
