import type { BuildingFootprint, EntrancePoint, LatLon, NearbyMapContext, RoadSegment } from "../types";

type OverpassElement = {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  lat?: number;
  lon?: number;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function parseHeightMeters(raw: string | undefined) {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  // common forms: "12", "12.5", "12 m", "12m"
  const m = s.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*(m)?\s*$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseLevels(raw: string | undefined) {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
}

function pointInPolygon(point: LatLon, polygon: LatLon[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat + Number.EPSILON) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distancePointToSegmentMeters(point: LatLon, a: LatLon, b: LatLon) {
  const metersPerDegLat = 111_132;
  const metersPerDegLon = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const px = 0;
  const py = 0;
  const ax = (a.lon - point.lon) * metersPerDegLon;
  const ay = (a.lat - point.lat) * metersPerDegLat;
  const bx = (b.lon - point.lon) * metersPerDegLon;
  const by = (b.lat - point.lat) * metersPerDegLat;
  const abx = bx - ax;
  const aby = by - ay;
  const denom = abx * abx + aby * aby;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -((ax - px) * abx + (ay - py) * aby) / denom));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(cx - px, cy - py);
}

function attachEntrancesToBuildings(buildings: BuildingFootprint[], entrances: EntrancePoint[]) {
  for (const entrance of entrances) {
    let bestBuilding: BuildingFootprint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const building of buildings) {
      if (pointInPolygon(entrance.location, building.polygon)) {
        bestBuilding = building;
        bestDistance = 0;
        break;
      }

      for (let i = 0; i < building.polygon.length - 1; i++) {
        const a = building.polygon[i]!;
        const b = building.polygon[i + 1]!;
        const distance = distancePointToSegmentMeters(entrance.location, a, b);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestBuilding = building;
        }
      }
    }

    if (bestBuilding && bestDistance <= 12) {
      bestBuilding.entrances.push(entrance);
    }
  }
}

function asClosedPolygon(points: LatLon[]) {
  if (points.length < 4) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.lat !== last.lat || first.lon !== last.lon) return null;
  return points;
}

export async function fetchBuildingsOverpass(params: {
  center: LatLon;
  radiusM: number;
  defaultHeightM?: number;
}): Promise<NearbyMapContext> {
  const { center, radiusM } = params;
  const defaultHeightM = params.defaultHeightM ?? 10;

  const query = `
  [out:json][timeout:60];
  (
    way["building"](around:${Math.round(radiusM)},${center.lat},${center.lon});
    way["building:part"](around:${Math.round(radiusM)},${center.lat},${center.lon});
    node["entrance"](around:${Math.round(radiusM)},${center.lat},${center.lon});
    way["highway"](around:${Math.round(radiusM)},${center.lat},${center.lon});
  );
  out geom tags;
  `;

  const json = await fetchOverpassWithFallback(query);

  const buildings: BuildingFootprint[] = [];
  const roads: RoadSegment[] = [];
  const entrances: EntrancePoint[] = [];
  for (const el of json.elements ?? []) {
    if (el.type === "node") {
      if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      const entranceTag = el.tags?.entrance;
      if (!entranceTag) continue;
      entrances.push({
        location: { lat: el.lat, lon: el.lon },
        kind: entranceTag === "main" ? "main" : "secondary"
      });
      continue;
    }

    if (el.type !== "way") continue;
    const geom = el.geometry ?? [];
    if (!geom.length) continue;
    const points = geom.map((p) => ({ lat: p.lat, lon: p.lon }));

    if (el.tags?.highway) {
      if (points.length >= 2 && !["steps", "path", "cycleway", "track"].includes(el.tags.highway)) {
        roads.push({
          points,
          highway: el.tags.highway
        });
      }
      continue;
    }

    const poly = asClosedPolygon(points);
    if (!poly || (!el.tags?.building && !el.tags?.["building:part"])) continue;

    const heightTag = parseHeightMeters(el.tags?.height);
    const levels = parseLevels(el.tags?.["building:levels"]);
    const roofHeight = parseHeightMeters(el.tags?.["roof:height"]);
    const roofLevels = parseLevels(el.tags?.["roof:levels"]);
    const minHeight = parseHeightMeters(el.tags?.["min_height"]);
    const minLevels = parseLevels(el.tags?.["building:min_level"]);

    let heightM: number;
    let heightSource: BuildingFootprint["heightSource"];
    if (heightTag !== undefined) {
      heightM = heightTag;
      heightSource = "height";
    } else if (levels !== undefined) {
      heightM = Math.max(1, levels) * 3 + (roofHeight ?? (roofLevels !== undefined ? Math.max(0, roofLevels) * 3 : 0));
      heightSource = "levels";
    } else {
      heightM = defaultHeightM;
      heightSource = "assumed";
    }

    const minHeightM = minHeight ?? (minLevels !== undefined ? Math.max(0, minLevels) * 3 : 0);

    buildings.push({ polygon: poly, heightM, minHeightM, heightSource, entrances: [] });
  }

  attachEntrancesToBuildings(buildings, entrances);
  return { buildings, roads };
}

async function fetchOverpassWithFallback(query: string) {
  let lastError: string | null = null;

  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        body: query,
        headers: { "content-type": "text/plain", accept: "application/json" }
      });
      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`.trim();
        continue;
      }
      return (await response.json()) as OverpassResponse;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    lastError && /504|timed out|abort/i.test(lastError)
      ? "Building data is temporarily busy. Please try again in a moment."
      : `Building data unavailable right now${lastError ? `: ${lastError}` : ""}`
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeout);
  }
}
