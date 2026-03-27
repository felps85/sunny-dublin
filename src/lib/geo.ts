export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function wrap360(deg: number) {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

export function angleDiffDeg(a: number, b: number) {
  const d = wrap360(a - b);
  return d > 180 ? 360 - d : d;
}

export function formatDublinTime(d: Date) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: "Europe/Dublin",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

export function haversineDistanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

export function toLocalXYMeters(params: { lat: number; lon: number; refLat: number; refLon: number }) {
  const { lat, lon, refLat, refLon } = params;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((refLat * Math.PI) / 180);
  return {
    x: (lon - refLon) * mPerDegLon,
    y: (lat - refLat) * mPerDegLat
  };
}

