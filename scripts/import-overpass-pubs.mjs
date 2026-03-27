import fs from "node:fs/promises";
import path from "node:path";

const OUT_PATH = path.resolve(process.cwd(), process.argv[2] ?? "public/pubs.json");
const CURATED_PUBS_PATH = path.resolve(process.cwd(), "scripts/curated-pubs.json");
const DUBLIN_CENTER = { lat: 53.3498, lon: -6.2603 };
const IMPORT_BOUNDS = {
  south: 51.35,
  north: 55.45,
  west: -10.75,
  east: -5.2
};
const TILE_COLS = 5;
const TILE_ROWS = 6;
const ROAD_CONTEXT_RADIUS_M = 120;
const BUILDING_CONTEXT_RADIUS_M = 90;
const OVERPASS_TIMEOUT_S = 90;
const INCLUDE_ROAD_CONTEXT = false;
const INCLUDE_BUILDING_CONTEXT = false;

const OVERPASS_ENDPOINTS = [
  "https://h24.atownsend.org.uk/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function pickLatLon(el) {
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  return null;
}

function haversineDistanceM(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
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

function sourcePriority(type) {
  if (type === "node") return 0;
  if (type === "way") return 1;
  if (type === "relation") return 2;
  return 3;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrap360(deg) {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

function bearingDiff(a, b) {
  const diff = Math.abs(wrap360(a - b));
  return diff > 180 ? 360 - diff : diff;
}

function toLocalXYMeters(point, ref) {
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((ref.lat * Math.PI) / 180);
  return {
    x: (point.lon - ref.lon) * mPerDegLon,
    y: (point.lat - ref.lat) * mPerDegLat
  };
}

function fromLocalXYMeters(point, ref) {
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((ref.lat * Math.PI) / 180);
  return {
    lat: ref.lat + point.y / mPerDegLat,
    lon: ref.lon + point.x / mPerDegLon
  };
}

function bearingFromTo(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return wrap360(toDeg(Math.atan2(y, x)));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

async function readCuratedPubs() {
  try {
    const raw = await fs.readFile(CURATED_PUBS_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!Array.isArray(json)) return [];

    return json
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const anyRow = row;
        if (typeof anyRow.name !== "string" || typeof anyRow.lat !== "number" || typeof anyRow.lon !== "number") {
          return null;
        }

        return {
          id:
            typeof anyRow.id === "string" && anyRow.id.trim().length > 0
              ? anyRow.id
              : `${slugify(anyRow.name)}-curated`,
          name: anyRow.name,
          lat: anyRow.lat,
          lon: anyRow.lon,
          displayLat: typeof anyRow.displayLat === "number" ? anyRow.displayLat : anyRow.lat,
          displayLon: typeof anyRow.displayLon === "number" ? anyRow.displayLon : anyRow.lon,
          sourceType: "curated",
          explicitFrontBearingDeg:
            typeof anyRow.frontBearingDeg === "number" ? anyRow.frontBearingDeg : undefined,
          explicitShadeClearanceDeg:
            typeof anyRow.shadeClearanceDeg === "number" ? anyRow.shadeClearanceDeg : undefined
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `Curated pub supplement unavailable at ${CURATED_PUBS_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

function parseNumberLike(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function defaultHeightMForPoint(point) {
  void point;
  return 12;
}

function parseHeightM(tags, point) {
  const explicitHeight = parseNumberLike(tags?.height);
  if (explicitHeight !== undefined) return explicitHeight;

  const levels = parseNumberLike(tags?.["building:levels"]);
  if (levels !== undefined) {
    const roofHeight = parseNumberLike(tags?.["roof:height"]) ?? 0;
    return levels * 3.2 + roofHeight;
  }

  return defaultHeightMForPoint(point);
}

function roadWidthForHighway(highway) {
  switch (highway) {
    case "footway":
    case "pedestrian":
      return 7;
    case "service":
    case "living_street":
      return 8;
    case "residential":
    case "unclassified":
      return 10;
    case "tertiary":
      return 12;
    case "secondary":
      return 15;
    case "primary":
    case "trunk":
      return 18;
    default:
      return 10;
  }
}

function nearestPointOnSegment(point, a, b) {
  const p = toLocalXYMeters(point, point);
  const pa = toLocalXYMeters(a, point);
  const pb = toLocalXYMeters(b, point);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return {
      point: a,
      distanceM: Math.hypot(pa.x - p.x, pa.y - p.y),
      segmentBearingDeg: bearingFromTo(a, b)
    };
  }

  const t = clamp(((p.x - pa.x) * dx + (p.y - pa.y) * dy) / len2, 0, 1);
  const closestXY = { x: pa.x + dx * t, y: pa.y + dy * t };
  const closestPoint = fromLocalXYMeters(closestXY, point);

  return {
    point: closestPoint,
    distanceM: Math.hypot(closestXY.x - p.x, closestXY.y - p.y),
    segmentBearingDeg: bearingFromTo(a, b)
  };
}

function closestRoadForPub(pub, roads) {
  let best = null;
  for (const road of roads) {
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const a = road.points[index];
      const b = road.points[index + 1];
      const candidate = nearestPointOnSegment(pub, a, b);
      if (!best || candidate.distanceM < best.distanceM) {
        best = {
          ...candidate,
          highway: road.highway
        };
      }
    }
  }
  return best;
}

function deriveFrontBearing(pub, roadMatch) {
  if (!roadMatch) return undefined;
  if (roadMatch.distanceM > 2) return bearingFromTo(pub, roadMatch.point);

  const optionA = wrap360(roadMatch.segmentBearingDeg + 90);
  const optionB = wrap360(roadMatch.segmentBearingDeg - 90);
  const towardRoad = bearingFromTo(pub, roadMatch.point);
  const diffA = bearingDiff(optionA, towardRoad);
  const diffB = bearingDiff(optionB, towardRoad);
  return diffA <= diffB ? optionA : optionB;
}

function inferLocalBuildingHeight(pub, roadMatch, buildings) {
  const refPoint = roadMatch?.point ?? pub;
  const samples = [];
  for (const building of buildings) {
    const distanceM = haversineDistanceM(refPoint, building.center);
    if (distanceM <= 65) {
      samples.push({ distanceM, heightM: building.heightM });
    }
  }

  if (!samples.length) return defaultHeightMForPoint(pub);

  samples.sort((a, b) => a.distanceM - b.distanceM);
  const nearestHeights = samples.slice(0, 6).map((sample) => sample.heightM).sort((a, b) => a - b);
  return nearestHeights[Math.floor(nearestHeights.length / 2)] ?? defaultHeightMForPoint(pub);
}

function inferShadeClearanceDeg(pub, roadMatch, localHeightM) {
  if (!roadMatch) return 10;
  const roadWidthM = roadWidthForHighway(roadMatch?.highway);
  const pubSetbackM = roadMatch ? clamp(roadMatch.distanceM, 0, 6) : 3;
  const effectiveWidthM = Math.max(roadWidthM - pubSetbackM * 0.35, 4.5);
  const clearanceDeg = (Math.atan2(localHeightM * 0.82, effectiveWidthM) * 180) / Math.PI;
  return clamp(clearanceDeg, 5, 30);
}

function normalizeRoad(el) {
  if (el?.type !== "way" || !el?.tags?.highway || !Array.isArray(el.geometry)) return null;
  const points = el.geometry
    .map((point) =>
      point && typeof point.lat === "number" && typeof point.lon === "number"
        ? { lat: point.lat, lon: point.lon }
        : null
    )
    .filter(Boolean);
  if (points.length < 2) return null;
  return {
    highway: el.tags.highway,
    points
  };
}

function normalizeBuilding(el) {
  if (!el?.tags || !(el.tags.building || el.tags["building:part"])) return null;
  const center = pickLatLon(el);
  if (!center) return null;
  return {
    center,
    heightM: parseHeightM(el.tags, center)
  };
}

function bboxAroundCenter(center, radiusM) {
  const latDelta = radiusM / 111_132;
  const lonDelta = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return {
    south: center.lat - latDelta,
    north: center.lat + latDelta,
    west: center.lon - lonDelta,
    east: center.lon + lonDelta
  };
}

function splitBounds(bounds, rows, cols) {
  const latStep = (bounds.north - bounds.south) / rows;
  const lonStep = (bounds.east - bounds.west) / cols;
  const tiles = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      tiles.push({
        key: `r${row + 1}c${col + 1}`,
        south: bounds.south + row * latStep,
        north: bounds.south + (row + 1) * latStep,
        west: bounds.west + col * lonStep,
        east: bounds.west + (col + 1) * lonStep
      });
    }
  }

  return tiles;
}

function subdivideTile(tile) {
  const midLat = (tile.south + tile.north) / 2;
  const midLon = (tile.west + tile.east) / 2;
  return [
    { key: `${tile.key}a`, south: tile.south, north: midLat, west: tile.west, east: midLon },
    { key: `${tile.key}b`, south: tile.south, north: midLat, west: midLon, east: tile.east },
    { key: `${tile.key}c`, south: midLat, north: tile.north, west: tile.west, east: midLon },
    { key: `${tile.key}d`, south: midLat, north: tile.north, west: midLon, east: tile.east }
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverpassJson(query, label) {
  let lastError;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_S * 1000);
      const response = await fetch(url, {
        method: "POST",
        body: query,
        headers: { "content-type": "text/plain", accept: "application/json" },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Overpass error: ${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`[${label}] ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError ?? new Error(`All Overpass endpoints failed for ${label}`);
}

function pubsContextQuery({ tile, includeBuildings }) {
  const pubsBlock = `
(
  node["amenity"~"^(pub|bar)$"](${tile.south},${tile.west},${tile.north},${tile.east});
  way["amenity"~"^(pub|bar)$"](${tile.south},${tile.west},${tile.north},${tile.east});
  relation["amenity"~"^(pub|bar)$"](${tile.south},${tile.west},${tile.north},${tile.east});
)->.pubs;
`;

  const roadsBlock = INCLUDE_ROAD_CONTEXT
    ? `
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway)$"](around.pubs:${ROAD_CONTEXT_RADIUS_M});
)->.roads;
`
    : "";

  const buildingsBlock = includeBuildings
    ? `
(
  way["building"](around.pubs:${BUILDING_CONTEXT_RADIUS_M});
  relation["building"](around.pubs:${BUILDING_CONTEXT_RADIUS_M});
  way["building:part"](around.pubs:${BUILDING_CONTEXT_RADIUS_M});
  relation["building:part"](around.pubs:${BUILDING_CONTEXT_RADIUS_M});
)->.buildings;
`
    : "";

  return `
[out:json][timeout:${OVERPASS_TIMEOUT_S}];
${pubsBlock}
${roadsBlock}
${buildingsBlock}
(${includeBuildings ? ".pubs; .roads; .buildings;" : INCLUDE_ROAD_CONTEXT ? ".pubs; .roads;" : ".pubs;"} );
out center geom tags;
`;
}

async function fetchTileElements(tile, depth = 0) {
  try {
    const json = await fetchOverpassJson(
      pubsContextQuery({ tile, includeBuildings: INCLUDE_BUILDING_CONTEXT }),
      `${tile.key}:${INCLUDE_BUILDING_CONTEXT ? "full" : "roads-only"}`
    );
    const elements = Array.isArray(json.elements) ? json.elements : [];
    console.log(`[${tile.key}] fetched ${elements.length} elements (${INCLUDE_BUILDING_CONTEXT ? "roads + buildings" : "roads only"})`);
    return { elements, roadsOnlyTiles: INCLUDE_BUILDING_CONTEXT ? 0 : 1, skippedTiles: 0 };
  } catch (fullError) {
    try {
      const json = await fetchOverpassJson(pubsContextQuery({ tile, includeBuildings: false }), `${tile.key}:roads-only`);
      const elements = Array.isArray(json.elements) ? json.elements : [];
      console.warn(`[${tile.key}] roads-only fallback: ${fullError instanceof Error ? fullError.message : String(fullError)}`);
      console.log(`[${tile.key}] fetched ${elements.length} elements (roads only)`);
      return { elements, roadsOnlyTiles: 1, skippedTiles: 0 };
    } catch (roadsOnlyError) {
      if (depth < 2) {
        console.warn(
          `[${tile.key}] splitting into smaller tiles after failure: ${
            roadsOnlyError instanceof Error ? roadsOnlyError.message : String(roadsOnlyError)
          }`
        );
        const childResults = [];
        for (const child of subdivideTile(tile)) {
          childResults.push(await fetchTileElements(child, depth + 1));
          await sleep(500);
        }
        return childResults.reduce(
          (acc, result) => ({
            elements: acc.elements.concat(result.elements),
            roadsOnlyTiles: acc.roadsOnlyTiles + result.roadsOnlyTiles,
            skippedTiles: acc.skippedTiles + result.skippedTiles
          }),
          { elements: [], roadsOnlyTiles: 0, skippedTiles: 0 }
        );
      }

      console.warn(
        `[${tile.key}] skipped after repeated failures: ${
          roadsOnlyError instanceof Error ? roadsOnlyError.message : String(roadsOnlyError)
        }`
      );
      return { elements: [], roadsOnlyTiles: 0, skippedTiles: 1 };
    }
  }
}

async function main() {
  const curatedPubs = await readCuratedPubs();
  const tiles = splitBounds(IMPORT_BOUNDS, TILE_ROWS, TILE_COLS);
  const rawPubs = [];
  const roads = [];
  const buildings = [];
  const seenRoads = new Set();
  const seenBuildings = new Set();
  let roadsOnlyTiles = 0;
  let skippedTiles = 0;

  for (const tile of tiles) {
    const result = await fetchTileElements(tile);
    roadsOnlyTiles += result.roadsOnlyTiles;
    skippedTiles += result.skippedTiles;

    for (const el of result.elements) {
      if (el?.tags?.amenity === "pub" || el?.tags?.amenity === "bar") {
        const name = el?.tags?.name;
        const ll = pickLatLon(el);
        if (!name || !ll) continue;
        rawPubs.push({
          id: `${slugify(name)}-${el.type}-${el.id}`,
          name,
          lat: ll.lat,
          lon: ll.lon,
          displayLat: ll.lat,
          displayLon: ll.lon,
          sourceType: el.type
        });
        continue;
      }

      const road = normalizeRoad(el);
      if (road) {
        const roadKey = `${el.type}:${el.id}`;
        if (!seenRoads.has(roadKey)) {
          roads.push(road);
          seenRoads.add(roadKey);
        }
        continue;
      }

      const building = normalizeBuilding(el);
      if (building) {
        const buildingKey = `${el.type}:${el.id}`;
        if (!seenBuildings.has(buildingKey)) {
          buildings.push(building);
          seenBuildings.add(buildingKey);
        }
      }
    }

    await sleep(900);
  }

  rawPubs.push(...curatedPubs);

  const deduped = [];
  for (const pub of rawPubs) {
    const existingIndex = deduped.findIndex(
      (candidate) => slugify(candidate.name) === slugify(pub.name) && haversineDistanceM(candidate, pub) < 120
    );
    if (existingIndex === -1) {
      deduped.push(pub);
      continue;
    }

    if (sourcePriority(pub.sourceType) < sourcePriority(deduped[existingIndex].sourceType)) {
      deduped[existingIndex] = pub;
    }
  }

  const finalPubs = deduped
    .map(({ sourceType, explicitFrontBearingDeg, explicitShadeClearanceDeg, ...pub }) => {
      const roadMatch = closestRoadForPub(pub, roads);
      const frontBearingDeg = explicitFrontBearingDeg ?? deriveFrontBearing(pub, roadMatch);
      const localHeightM = inferLocalBuildingHeight(pub, roadMatch, buildings);
      const shadeClearanceDeg = explicitShadeClearanceDeg ?? inferShadeClearanceDeg(pub, roadMatch, localHeightM);

      return {
        ...pub,
        frontBearingDeg: frontBearingDeg !== undefined ? round1(frontBearingDeg) : undefined,
        shadeClearanceDeg: round1(shadeClearanceDeg)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en-IE"));

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(finalPubs, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${finalPubs.length} pubs to ${OUT_PATH} using ${tiles.length - roadsOnlyTiles}/${tiles.length} tiles with building context; skipped ${skippedTiles} tiles`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
