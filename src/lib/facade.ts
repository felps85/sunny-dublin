import type { BuildingFootprint, EntrancePoint, FacadeInference, LatLon, RoadSegment } from "../types";
import { toLocalXYMeters, wrap360 } from "./geo";

type Vec2 = { x: number; y: number };

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Vec2, b: Vec2) {
  return a.x * b.x + a.y * b.y;
}

function len(a: Vec2) {
  return Math.hypot(a.x, a.y);
}

function lenSq(a: Vec2) {
  return a.x * a.x + a.y * a.y;
}

function closestPointOnSegment(point: Vec2, a: Vec2, b: Vec2) {
  const ab = sub(b, a);
  const ap = sub(point, a);
  const denom = lenSq(ab);
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / denom));
  return {
    point: { x: a.x + ab.x * t, y: a.y + ab.y * t },
    t
  };
}

function pointInRing(point: Vec2, ring: Vec2[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y + Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function vectorToBearing(v: Vec2) {
  return wrap360((Math.atan2(v.x, v.y) * 180) / Math.PI);
}

function normalize(v: Vec2) {
  const d = len(v);
  return d === 0 ? { x: 0, y: 0 } : { x: v.x / d, y: v.y / d };
}

function scoreEntrance(edgeMid: Vec2, entrances: EntrancePoint[], ref: LatLon) {
  let best = 0;
  let bestEntrance: EntrancePoint | undefined;
  for (const entrance of entrances) {
    const p = toLocalXYMeters({
      lat: entrance.location.lat,
      lon: entrance.location.lon,
      refLat: ref.lat,
      refLon: ref.lon
    });
    const distance = len(sub(p, edgeMid));
    if (distance > 18) continue;
    const score = (entrance.kind === "main" ? 90 : 55) - distance * 3;
    if (score > best) {
      best = score;
      bestEntrance = entrance;
    }
  }
  return { score: best, entrance: bestEntrance };
}

function scoreRoad(edgeMid: Vec2, facing: Vec2, roads: RoadSegment[], ref: LatLon) {
  let best = 0;
  let bestSegment: [LatLon, LatLon] | undefined;
  const facingNorm = normalize(facing);

  for (const road of roads) {
    const roadPoints = road.points.map((point) =>
      toLocalXYMeters({ lat: point.lat, lon: point.lon, refLat: ref.lat, refLon: ref.lon })
    );
    for (let i = 0; i < roadPoints.length - 1; i++) {
      const a = roadPoints[i]!;
      const b = roadPoints[i + 1]!;
      const closest = closestPointOnSegment(edgeMid, a, b).point;
      const toRoad = sub(closest, edgeMid);
      const distance = len(toRoad);
      if (distance > 28) continue;

      const towardRoad = dot(facingNorm, normalize(toRoad));
      if (towardRoad <= 0.15) continue;

      const roadBonus =
        road.highway === "residential" || road.highway === "tertiary" || road.highway === "secondary"
          ? 12
          : road.highway === "pedestrian" || road.highway === "footway"
            ? 18
            : 0;

      const score = towardRoad * 40 + Math.max(0, 26 - distance) + roadBonus;
      if (score > best) {
        best = score;
        bestSegment = [road.points[i]!, road.points[i + 1]!];
      }
    }
  }

  return { score: best, roadSegment: bestSegment };
}

export function inferFacadeFromBuildings(params: {
  point: LatLon;
  buildings: BuildingFootprint[];
  roads?: RoadSegment[];
  maxDistanceM?: number;
}): FacadeInference | undefined {
  const maxDistanceM = params.maxDistanceM ?? 40;
  const origin = { x: 0, y: 0 };
  const roads = params.roads ?? [];

  let best:
    | {
        score: number;
        bearingDeg: number;
        edge: [LatLon, LatLon];
        entrance?: EntrancePoint;
        roadSegment?: [LatLon, LatLon];
      }
    | undefined;

  for (const building of params.buildings) {
    const ring = building.polygon.map((p) =>
      toLocalXYMeters({ lat: p.lat, lon: p.lon, refLat: params.point.lat, refLon: params.point.lon })
    );
    if (ring.length < 2) continue;

    const inside = pointInRing(origin, ring);

    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      const closest = closestPointOnSegment(origin, a, b).point;
      const delta = sub(origin, closest);
      const distanceSq = lenSq(delta);
      if (distanceSq > maxDistanceM * maxDistanceM) continue;

      const edge = sub(b, a);
      const normalA = { x: -edge.y, y: edge.x };
      const normalB = { x: edge.y, y: -edge.x };
      const facing =
        inside
          ? dot(normalA, delta) < dot(normalB, delta)
            ? normalA
            : normalB
          : dot(normalA, delta) > dot(normalB, delta)
            ? normalA
            : normalB;

      const edgeMid = {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
      };
      const distanceM = Math.sqrt(distanceSq);
      const baseScore = Math.max(0, 60 - distanceM * 1.5);
      const entrance = scoreEntrance(edgeMid, building.entrances, params.point);
      const road = scoreRoad(edgeMid, facing, roads, params.point);
      const score = baseScore + entrance.score + road.score;

      if (!best || score > best.score) {
        best = {
          score,
          bearingDeg: vectorToBearing(facing),
          edge: [building.polygon[i]!, building.polygon[i + 1]!],
          entrance: entrance.entrance,
          roadSegment: road.roadSegment
        };
      }
    }
  }

  return best;
}

export function estimateFrontBearingFromBuildings(params: {
  point: LatLon;
  buildings: BuildingFootprint[];
  roads?: RoadSegment[];
  maxDistanceM?: number;
}) {
  return inferFacadeFromBuildings(params)?.bearingDeg;
}
