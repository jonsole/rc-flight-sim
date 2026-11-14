// Where the multiplayer relay lives (see server/). Override at build time
// with VITE_MP_SERVER, or in the Multiplayer menu (Server).
export const DEFAULT_MP_SERVER = import.meta.env?.VITE_MP_SERVER || '';
