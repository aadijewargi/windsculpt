// Compact, URL-safe encoding of a drawn profile for share links:
// 48 points, each coordinate in hundredths, "u_v" pairs joined by dots.

import { resample } from './shapes.js';

export function encodeProfile(pts, n = 48) {
  return resample(pts, n).map(([u, v]) => `${Math.round(u * 100)}_${Math.round(v * 100)}`).join('.');
}

/** Returns the polygon, or null for anything malformed. */
export function decodeProfile(s) {
  if (typeof s !== 'string' || s.length > 4000) return null;
  const pts = s.split('.').map((p) => p.split('_').map((n) => (/^-?\d+$/.test(n) ? +n / 100 : NaN)));
  const ok = pts.length >= 3 && pts.every((p) => p.length === 2 && p.every((c) => Number.isFinite(c) && Math.abs(c) <= 3));
  return ok ? pts : null;
}
