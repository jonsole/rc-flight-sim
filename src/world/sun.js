// Where the sun (and moon) are for a time of day, at a UK-like latitude.
// Standard low-precision solar position: declination from the day of the
// year, hour angle from local solar time. Accurate to about a degree, which
// is plenty for lighting a flying field.

const LATITUDE = 52; // degrees north
const deg = Math.PI / 180;

/** Day of the year (1-366) for a Date. */
export function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((now - start) / 86400000);
}

/** Day of the year of the last Sunday of a month (0-based), this year. */
function lastSunday(month, year) {
  const last = new Date(Date.UTC(year, month + 1, 0)); // the month's last day
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return dayOfYear(new Date(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()));
}

/** Is it British Summer Time on this day of the year (last Sunday of March to last Sunday of October)? */
export function isBST(day, year = new Date().getFullYear()) {
  return day >= lastSunday(2, year) && day < lastSunday(9, year);
}

/**
 * Local solar time (12 = the sun due south) for a UK clock time on a day of
 * the year: an hour back in British Summer Time, and the equation of time
 * (the sun runs up to ~16 minutes ahead of or behind the clock through the
 * year), at a field near Cambridge (0.1° E).
 */
export function solarHours(clock, day, longitude = 0.1) {
  const B = ((2 * Math.PI) / 365) * (day - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
  const h = clock - (isBST(day) ? 1 : 0) + longitude / 15 + eot / 60;
  return ((h % 24) + 24) % 24;
}

/**
 * Sun elevation and azimuth (degrees; azimuth 0 = north, 90 = east) for a
 * local solar time in hours (12 = noon) on a day of the year.
 */
export function sunPosition(hours, day = 172, latitude = LATITUDE) {
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10)) * deg;
  const lat = latitude * deg;
  const ha = (hours - 12) * 15 * deg; // hour angle, + in the afternoon
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // Azimuth from north, clockwise.
  const y = -Math.sin(ha) * Math.cos(decl);
  const x = Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(ha);
  let az = Math.atan2(y, x) / deg;
  if (az < 0) az += 360;
  return { elevation: el / deg, azimuth: az };
}

/**
 * The moon, simply: opposite the sun in the sky (a full moon), a little
 * higher, so there is moonlight all night.
 */
export function moonPosition(hours, day) {
  const s = sunPosition((hours + 12) % 24, day);
  return { elevation: s.elevation + 8, azimuth: s.azimuth };
}

/** Local time of day now, in hours. */
export function clockHours(date = new Date()) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** "14:30" */
export function formatHours(h) {
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
