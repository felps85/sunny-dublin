import type { BuildingFootprint, LatLon } from "../types";
import { toLocalXYMeters } from "./geo";

type Vec2 = { x: number; y: number };

function cross(a: Vec2, b: Vec2) {
  return a.x * b.y - a.y * b.x;
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function mul(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

function norm(a: Vec2) {
  const d = Math.hypot(a.x, a.y);
  return d === 0 ? { x: 0, y: 0 } : { x: a.x / d, y: a.y / d };
}

function raySegmentIntersection(params: { rayOrigin: Vec2; rayDir: Vec2; segA: Vec2; segB: Vec2 }) {
  const { rayOrigin: O, rayDir: D, segA: A, segB: B } = params;
  const S = sub(B, A);
  const denom = cross(D, S);
  if (Math.abs(denom) < 1e-9) return null;
  const AO = sub(A, O);
  const t = cross(AO, S) / denom;
  const u = cross(AO, D) / denom;
  if (t < 0) return null;
  if (u < 0 || u > 1) return null;
  return { t, point: add(O, mul(D, t)) };
}

function bearingToDir(bearingDegFromNorth: number) {
  const rad = (bearingDegFromNorth * Math.PI) / 180;
  // x east, y north
  return { x: Math.sin(rad), y: Math.cos(rad) };
}

function toLocalRing(points: LatLon[], ref: LatLon) {
  return points.map((p) => toLocalXYMeters({ lat: p.lat, lon: p.lon, refLat: ref.lat, refLon: ref.lon }));
}

function isPointInRing(point: Vec2, ring: Vec2[]) {
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

function offsetPoint(point: LatLon, bearingDegFromNorth: number, distanceM: number): LatLon {
  const rad = (bearingDegFromNorth * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111_132;
  const dLon = (distanceM * Math.sin(rad)) / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  return { lat: point.lat + dLat, lon: point.lon + dLon };
}

export function getFacadeSamplePoints(params: {
  point: LatLon;
  frontBearingDeg: number;
  facadeOffsetM?: number;
  facadeWidthM?: number;
  sampleCount?: number;
}) {
  const facadeOffsetM = params.facadeOffsetM ?? 1.5;
  const facadeWidthM = params.facadeWidthM ?? 7;
  const sampleCount = params.sampleCount ?? 3;
  const center = offsetPoint(params.point, params.frontBearingDeg, facadeOffsetM);
  const lateralBearing = (params.frontBearingDeg + 90) % 360;

  if (sampleCount <= 1) return [center];

  const spacing = facadeWidthM / (sampleCount - 1);
  const start = -facadeWidthM / 2;
  const points: LatLon[] = [];
  for (let i = 0; i < sampleCount; i++) {
    points.push(offsetPoint(center, lateralBearing, start + i * spacing));
  }
  return points;
}

export function isPointShadowedByBuildings(params: {
  point: LatLon;
  sunBearingDeg: number;
  sunAltitudeDeg: number;
  buildings: BuildingFootprint[];
  frontBearingDeg?: number;
  facadeOffsetM?: number;
  maxCheckDistanceM?: number;
}) {
  const { point, sunBearingDeg, sunAltitudeDeg, buildings } = params;
  const maxDist = params.maxCheckDistanceM ?? 400;
  if (sunAltitudeDeg <= 0) return true;

  const tanAlt = Math.tan((sunAltitudeDeg * Math.PI) / 180);
  if (!Number.isFinite(tanAlt) || tanAlt <= 0) return true;

  const originPoint =
    params.frontBearingDeg === undefined
      ? point
      : offsetPoint(point, params.frontBearingDeg, params.facadeOffsetM ?? 1.5);

  const O = { x: 0, y: 0 };
  const D = norm(bearingToDir(sunBearingDeg));

  for (const b of buildings) {
    const ring = toLocalRing(b.polygon, originPoint);
    if (isPointInRing(O, ring)) continue;

    for (let i = 0; i < ring.length - 1; i++) {
      const A = ring[i]!;
      const B = ring[i + 1]!;
      const hit = raySegmentIntersection({ rayOrigin: O, rayDir: D, segA: A, segB: B });
      if (!hit) continue;
      const d = hit.t;
      if (d > maxDist) continue;
      const requiredHeight = d * tanAlt;
      if (requiredHeight >= b.minHeightM && b.heightM >= requiredHeight) return true;
    }
  }

  return false;
}
