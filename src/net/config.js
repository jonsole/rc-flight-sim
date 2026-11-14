// Where the multiplayer relay lives (server/, a Cloudflare Worker deployed by
// Workers Builds from this repo). Override at build time
// with VITE_MP_SERVER, or in the Multiplayer menu (Server).
export const DEFAULT_MP_SERVER = import.meta.env?.VITE_MP_SERVER || '';
