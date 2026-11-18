// Start-up progress on the splash screen: which stage it's at, how far
// through that stage (a percentage and a bar), set by boot.js and main.js.
const status = document.querySelector('#splash .sub');
let bar = null;
let fill = null;

/** Show `label` at `frac` (0-1) of the way through it; frac null: no bar. */
export function setStage(label, frac = 0) {
  if (!status) return;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'load-bar';
    fill = document.createElement('div');
    bar.append(fill);
    status.after(bar);
  }
  if (frac == null) {
    status.textContent = label;
    bar.hidden = true;
    return;
  }
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  status.textContent = `${label} ${pct}%`;
  bar.hidden = false;
  fill.style.width = `${pct}%`;
}

/** Let the screen show the latest progress before carrying on. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/**
 * Fetch `url` as JSON, reporting progress (0-1) as it downloads.
 * @param {(frac: number) => void} onProgress
 * @param {number} [size]  its size in bytes, if known (a compressed
 *   download's content-length is its compressed size, so no use)
 */
export async function fetchJsonWithProgress(url, onProgress, size = 0) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const compressed = !!res.headers.get('content-encoding');
  const total = size || (compressed ? 0 : Number(res.headers.get('content-length')) || 0);
  if (!res.body || !total) {
    const j = await res.json();
    onProgress(1);
    return j;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(0.99, got / total));
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  onProgress(1);
  return JSON.parse(new TextDecoder().decode(all));
}
