// Full screen: the whole screen for the simulator, without the browser's
// address bar and buttons. Phones and tablets go full screen when you press
// Fly (Menu → View: "Full screen on phones and tablets"); FULL on the touch
// bar or F on a keyboard switches it on and off.
//
// Browsers only allow it in answer to a tap, click or key, so it's asked
// for from those. Android browsers, iPads and desktops have it; iPhone
// Safari doesn't (only videos go full screen there): there, "Add to Home
// Screen" opens the simulator as an app, with no browser bars at all
// (index.html: the manifest and the Apple web-app settings).

const root = () => document.documentElement;

/** Can this browser put the page full screen? */
export function canFullscreen() {
  const el = root();
  const api = el.requestFullscreen || el.webkitRequestFullscreen;
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true;
  return !!api && enabled !== false;
}

/** Is it full screen now? */
export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/** Opened from the home screen as an app (already with no browser bars)? */
export function isStandalone() {
  return window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.matchMedia?.('(display-mode: standalone)').matches
    || navigator.standalone === true;
}

/** Full screen (from a tap, click or key), and landscape where the phone allows it. */
export function enterFullscreen() {
  if (!canFullscreen() || isFullscreen()) return;
  const el = root();
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
    // Held sideways: the sticks need the width. (Only allowed full screen,
    // and not everywhere: never mind if it isn't.)
    Promise.resolve(p).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  } catch {
    /* not allowed here */
  }
}

export function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* ignore */
  }
  const p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.();
  Promise.resolve(p).catch(() => {});
}

export function toggleFullscreen() {
  if (isFullscreen()) exitFullscreen();
  else enterFullscreen();
}

/** Call fn whenever it goes into or out of full screen. */
export function onFullscreenChange(fn) {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
}

/** An iPhone (or iPod) in Safari: no full screen, but Add to Home Screen. */
export function isIPhone() {
  return /iPhone|iPod/.test(navigator.userAgent) && !isStandalone();
}
