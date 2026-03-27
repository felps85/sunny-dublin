import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import SunCalc from "suncalc";
import { SEED_PUBS } from "./data/pubs";
import type { ForecastHour, LatLon, MapViewport, Pub } from "./types";
import { fetchForecastHourly } from "./lib/openMeteo";
import {
  computeFrontSunnyHours,
  computeFrontSunnySamples,
  computeGeneralSunnyHours,
  computeGeneralSunnySamples,
  makeTimeGrid,
  sunnyIntervalsFromHours
} from "./lib/sun";
import { formatDublinTime, haversineDistanceM } from "./lib/geo";
import { readCachedJson, readJson, readNumber, writeCachedJson, writeJson, writeNumber } from "./lib/storage";
import { requestUserLocation } from "./lib/location";
import MaterialIcon from "./components/MaterialIcon";

const IRELAND_CENTER = { lat: 53.425, lon: -7.9441 };
const PubMap = lazy(() => import("./components/PubMap"));
const FORECAST_CACHE_MS = 15 * 60_000;
const ADDRESS_CACHE_MS = 7 * 24 * 60 * 60_000;
const SUN_CHASE_CANDIDATE_LIMIT = 80;
const SUN_CHASE_STOP_LIMIT = 4;
const SUN_CHASE_MIN_STOP_MINUTES = 15;
const WALKING_METERS_PER_MINUTE = 80;

const REGION_OPTIONS = [
  { id: "all", label: "All Ireland", bounds: null },
  { id: "dublin", label: "Dublin", bounds: { south: 53.19, north: 53.46, west: -6.55, east: -6.00 } },
  { id: "cork", label: "Cork", bounds: { south: 51.80, north: 52.02, west: -8.63, east: -8.32 } },
  { id: "galway", label: "Galway", bounds: { south: 53.22, north: 53.36, west: -9.22, east: -8.90 } },
  { id: "limerick", label: "Limerick", bounds: { south: 52.58, north: 52.75, west: -8.78, east: -8.48 } },
  { id: "waterford", label: "Waterford", bounds: { south: 52.20, north: 52.34, west: -7.20, east: -6.98 } },
  { id: "belfast", label: "Belfast", bounds: { south: 54.50, north: 54.70, west: -6.15, east: -5.75 } },
  { id: "derry", label: "Derry", bounds: { south: 54.95, north: 55.05, west: -7.40, east: -7.22 } },
  { id: "kilkenny", label: "Kilkenny", bounds: { south: 52.61, north: 52.69, west: -7.30, east: -7.18 } },
  { id: "sligo", label: "Sligo", bounds: { south: 54.24, north: 54.32, west: -8.53, east: -8.41 } },
  { id: "athlone", label: "Athlone", bounds: { south: 53.39, north: 53.46, west: -7.98, east: -7.88 } },
  { id: "drogheda", label: "Drogheda", bounds: { south: 53.69, north: 53.75, west: -6.40, east: -6.30 } },
  { id: "wexford", label: "Wexford", bounds: { south: 52.31, north: 52.37, west: -6.49, east: -6.42 } },
  { id: "letterkenny", label: "Letterkenny", bounds: { south: 54.92, north: 54.98, west: -7.77, east: -7.69 } }
] as const;

type SunChaseStop = {
  pub: Pub;
  anchor: LatLon;
  interval: { start: Date; end: Date };
  sunnyStart: Date;
  walkMinutesFromPrev: number;
  distanceMFromPrev: number;
  departAt?: Date;
};

function normalizeForecastRows(rows: ForecastHour[]) {
  return rows.map((row) => ({
    ...row,
    time: row.time instanceof Date ? row.time : new Date(row.time)
  }));
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function readStoredUserLocation() {
  const raw = readJson<unknown>("user-location");
  if (!raw || typeof raw !== "object") return null;
  const anyRaw = raw as Record<string, unknown>;
  return typeof anyRaw.lat === "number" && typeof anyRaw.lon === "number"
    ? { lat: anyRaw.lat, lon: anyRaw.lon }
    : null;
}

function makeForecastCacheKey(location: LatLon, hours: number) {
  const lat = location.lat.toFixed(4);
  const lon = location.lon.toFixed(4);
  return `forecast:${lat}:${lon}:${hours}`;
}

function useForecast(location: LatLon | null, hours: number, refreshKey: number) {
  const [data, setData] = useState<ForecastHour[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!location) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const cacheKey = makeForecastCacheKey(location, hours);
    const cachedRaw = refreshKey === 0 ? readCachedJson<ForecastHour[]>(cacheKey) : undefined;
    const cached = cachedRaw ? normalizeForecastRows(cachedRaw) : undefined;
    setError(null);
    setData(cached ?? null);
    fetchForecastHourly({ lat: location.lat, lon: location.lon, hours })
      .then((rows) => {
        if (!cancelled) {
          const normalized = normalizeForecastRows(rows);
          setData(normalized);
          writeCachedJson(cacheKey, normalized, FORECAST_CACHE_MS);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled && !cached) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [hours, location, refreshKey]);

  return { data, error };
}

type ForecastGridPoint = {
  anchor: LatLon;
  forecast: ForecastHour[];
};

function quantizeCoordinate(value: number, step: number) {
  return Math.round(value / step) * step;
}

function buildViewportForecastAnchors(viewport: MapViewport | null) {
  if (!viewport) return [];

  const latSpan = Math.max(0.02, viewport.north - viewport.south);
  const lonSpan = Math.max(0.02, viewport.east - viewport.west);
  const latInset = latSpan * 0.22;
  const lonInset = lonSpan * 0.22;
  const rawAnchors: LatLon[] = [
    viewport.center,
    { lat: viewport.north - latInset, lon: viewport.west + lonInset },
    { lat: viewport.north - latInset, lon: viewport.east - lonInset },
    { lat: viewport.south + latInset, lon: viewport.west + lonInset },
    { lat: viewport.south + latInset, lon: viewport.east - lonInset }
  ];

  const seen = new Set<string>();
  return rawAnchors.flatMap((anchor) => {
    const quantized = {
      lat: quantizeCoordinate(anchor.lat, 0.02),
      lon: quantizeCoordinate(anchor.lon, 0.02)
    };
    const key = `${quantized.lat.toFixed(2)}:${quantized.lon.toFixed(2)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [quantized];
  });
}

function useViewportForecastGrid(viewport: MapViewport | null, hours: number, refreshKey: number) {
  const anchors = useMemo(() => buildViewportForecastAnchors(viewport), [viewport]);
  const anchorKey = useMemo(
    () => anchors.map((anchor) => `${anchor.lat.toFixed(2)}:${anchor.lon.toFixed(2)}`).join("|"),
    [anchors]
  );
  const [data, setData] = useState<ForecastGridPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!anchors.length) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const cached = (refreshKey === 0
      ? anchors.flatMap((anchor) => {
          const cachedRaw = readCachedJson<ForecastHour[]>(makeForecastCacheKey(anchor, hours));
          if (!cachedRaw) return [];
          return [{ anchor, forecast: normalizeForecastRows(cachedRaw) }];
        })
      : []) satisfies ForecastGridPoint[];

    setError(null);
    setData(cached.length ? cached : null);

    Promise.allSettled(
      anchors.map(async (anchor) => {
        const rows = await fetchForecastHourly({ lat: anchor.lat, lon: anchor.lon, hours });
        const normalized = normalizeForecastRows(rows);
        writeCachedJson(makeForecastCacheKey(anchor, hours), normalized, FORECAST_CACHE_MS);
        return { anchor, forecast: normalized } satisfies ForecastGridPoint;
      })
    ).then((results) => {
      if (cancelled) return;

      const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (fulfilled.length) {
        setData(fulfilled);
        setError(null);
        return;
      }

      if (!cached.length) {
        const rejected = results.find((result) => result.status === "rejected");
        setError(rejected?.status === "rejected" ? String(rejected.reason) : "Couldn’t load local pub forecasts.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [anchorKey, anchors, hours, refreshKey]);

  return { data, error };
}

function pointNearViewport(point: LatLon, viewport: MapViewport | null) {
  if (!viewport) return false;
  const latPad = Math.max(0.01, (viewport.north - viewport.south) * 0.25);
  const lonPad = Math.max(0.01, (viewport.east - viewport.west) * 0.25);
  return (
    point.lat <= viewport.north + latPad &&
    point.lat >= viewport.south - latPad &&
    point.lon <= viewport.east + lonPad &&
    point.lon >= viewport.west - lonPad
  );
}

function pickForecastForPoint(
  point: LatLon,
  grid: ForecastGridPoint[] | null,
  fallback: ForecastHour[] | null,
  viewport: MapViewport | null
) {
  if (!grid?.length || !pointNearViewport(point, viewport)) return fallback;

  return grid.reduce<ForecastGridPoint | null>((best, candidate) => {
    if (!best) return candidate;
    const currentDistance = haversineDistanceM(point, candidate.anchor);
    const bestDistance = haversineDistanceM(point, best.anchor);
    return currentDistance < bestDistance ? candidate : best;
  }, null)?.forecast ?? fallback;
}

function pubBearingKey(pubId: string) {
  return `bearing:${pubId}`;
}

function getStoredBearing(pubId: string) {
  return readNumber(pubBearingKey(pubId));
}

function getTimeSliderValue(time: Date, base: Date) {
  return Math.max(0, Math.round((time.getTime() - base.getTime()) / 600_000));
}

function parseInitialView() {
  const params = new URLSearchParams(window.location.search);
  const selectedId = params.get("pub") ?? undefined;
  const previewTimeRaw = params.get("time");
  const previewTime = previewTimeRaw ? new Date(previewTimeRaw) : undefined;
  return {
    selectedId,
    previewTime: previewTime && !Number.isNaN(previewTime.getTime()) ? previewTime : undefined
  };
}

function getPubAnchor(pub: Pub): LatLon {
  if (pub.displayLat !== undefined && pub.displayLon !== undefined) {
    return { lat: pub.displayLat, lon: pub.displayLon };
  }
  return { lat: pub.lat, lon: pub.lon };
}

function estimateWalkingMinutes(distanceM: number) {
  return Math.max(2, Math.ceil(distanceM / WALKING_METERS_PER_MINUTE));
}

function buildGoogleMapsWalkingUrl(origin: LatLon, stops: LatLon[]) {
  if (!stops.length) return null;
  const destination = stops[stops.length - 1]!;
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lon}`,
    destination: `${destination.lat},${destination.lon}`,
    travelmode: "walking"
  });
  if (stops.length > 1) {
    params.set(
      "waypoints",
      stops
        .slice(0, -1)
        .map((stop) => `${stop.lat},${stop.lon}`)
        .join("|")
    );
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function pointInRegion(point: LatLon, regionId: (typeof REGION_OPTIONS)[number]["id"]) {
  const region = REGION_OPTIONS.find((option) => option.id === regionId);
  if (!region?.bounds) return true;
  return (
    point.lat >= region.bounds.south &&
    point.lat <= region.bounds.north &&
    point.lon >= region.bounds.west &&
    point.lon <= region.bounds.east
  );
}

function regionIdForPoint(point: LatLon | null) {
  if (!point) return null;
  const match = REGION_OPTIONS.find((option) => option.id !== "all" && option.bounds && pointInRegion(point, option.id));
  return match?.id ?? null;
}

function getRegionFallbackCenter(regionId: (typeof REGION_OPTIONS)[number]["id"]) {
  const region = REGION_OPTIONS.find((option) => option.id === regionId);
  if (!region?.bounds) return IRELAND_CENTER;
  return {
    lat: (region.bounds.south + region.bounds.north) / 2,
    lon: (region.bounds.west + region.bounds.east) / 2
  };
}

function getRegionFocus(regionId: (typeof REGION_OPTIONS)[number]["id"], pubs: Pub[]) {
  if (regionId === "all") {
    return { center: IRELAND_CENTER, zoom: 6.7 };
  }

  const regionPubs = pubs.filter((pub) => pointInRegion(getPubAnchor(pub), regionId));
  if (!regionPubs.length) {
    return { center: getRegionFallbackCenter(regionId), zoom: 11.3 };
  }

  const clusterRadiusM = 1200;
  let bestCenter = getPubAnchor(regionPubs[0]!);
  let bestScore = -1;

  for (const pub of regionPubs) {
    const anchor = getPubAnchor(pub);
    const nearby = regionPubs
      .map((candidate) => getPubAnchor(candidate))
      .filter((candidate) => haversineDistanceM(anchor, candidate) <= clusterRadiusM);

    if (nearby.length > bestScore) {
      bestScore = nearby.length;
      bestCenter = {
        lat: nearby.reduce((sum, point) => sum + point.lat, 0) / nearby.length,
        lon: nearby.reduce((sum, point) => sum + point.lon, 0) / nearby.length
      };
    }
  }

  const zoom = regionPubs.length >= 120 ? 13.2 : regionPubs.length >= 45 ? 12.6 : 11.9;
  return { center: bestCenter, zoom };
}

export default function App() {
  const initialViewRef = useRef(parseInitialView());
  const [query, setQuery] = useState("");
  const [regionId, setRegionId] = useState<(typeof REGION_OPTIONS)[number]["id"]>(() => regionIdForPoint(readStoredUserLocation()) ?? "dublin");
  const [showDrawer, setShowDrawer] = useState(false);
  const [quickFilter, setQuickFilter] = useState<"all" | "sunny">("all");
  const [pubs, setPubs] = useState<Pub[]>(SEED_PUBS);
  const [selectedId, setSelectedId] = useState<string | null>(initialViewRef.current.selectedId ?? null);
  const [showUserLocationPopover, setShowUserLocationPopover] = useState(false);
  const [showSunChase, setShowSunChase] = useState(false);
  const [selectedRecenterTick, setSelectedRecenterTick] = useState(0);
  const [userRecenterTick, setUserRecenterTick] = useState(0);
  const [regionFocusTick, setRegionFocusTick] = useState(0);
  const [bearingOverrides, setBearingOverrides] = useState<Record<string, number>>({});
  const selectedPub = useMemo(() => pubs.find((p) => p.id === selectedId) ?? null, [pubs, selectedId]);
  const initialRegionFocusedRef = useRef(false);

  const [forecastRefresh, setForecastRefresh] = useState(0);
  const [mapViewport, setMapViewport] = useState<MapViewport | null>(null);
  const [userLocation, setUserLocation] = useState<LatLon | null>(() => readStoredUserLocation());
  const { data: forecast, error } = useForecast(IRELAND_CENTER, 48, forecastRefresh);
  const { data: viewportForecastGrid, error: viewportForecastError } = useViewportForecastGrid(mapViewport, 48, forecastRefresh);
  const { data: userForecast, error: userForecastError } = useForecast(userLocation, 48, forecastRefresh);
  const [locError, setLocError] = useState<string | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedAddressLoading, setSelectedAddressLoading] = useState(false);
  const [showTimeSlider, setShowTimeSlider] = useState(false);
  const searchDockRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const timeDragStateRef = useRef<{ pointerId: number; startX: number; startSliderValue: number; moved: boolean } | null>(null);
  const suppressTimeClickRef = useRef(false);
  const [isDraggingTime, setIsDraggingTime] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadPubs = async () => {
      const candidates = ["/pubs-ireland-lite.json", "/pubs-ireland.json", "/pubs.json"];
      let json: unknown = null;

      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate);
          if (!response.ok) continue;
          json = await response.json();
          if (Array.isArray(json)) break;
        } catch {
          // try the next candidate
        }
      }

      if (!Array.isArray(json)) throw new Error("No valid pubs dataset found");

        const parsed: Pub[] = [];
        for (const row of json) {
          if (!row || typeof row !== "object") continue;
          const anyRow = row as Record<string, unknown>;
          const id = typeof anyRow.id === "string" ? anyRow.id : undefined;
          const name = typeof anyRow.name === "string" ? anyRow.name : undefined;
          const lat = typeof anyRow.lat === "number" ? anyRow.lat : undefined;
          const lon = typeof anyRow.lon === "number" ? anyRow.lon : undefined;
          const frontBearingDeg =
            typeof anyRow.frontBearingDeg === "number" ? (anyRow.frontBearingDeg as number) : undefined;
          const shadeClearanceDeg =
            typeof anyRow.shadeClearanceDeg === "number" ? (anyRow.shadeClearanceDeg as number) : undefined;
          const displayLat = typeof anyRow.displayLat === "number" ? anyRow.displayLat : undefined;
          const displayLon = typeof anyRow.displayLon === "number" ? anyRow.displayLon : undefined;
          if (!id || !name || lat === undefined || lon === undefined) continue;
          parsed.push({ id, name, lat, lon, displayLat, displayLon, frontBearingDeg, shadeClearanceDeg });
        }

        if (!cancelled && parsed.length) {
          setPubs(parsed);
          setSelectedId((prev) => (prev && parsed.some((p) => p.id === prev) ? prev : null));
          setBearingOverrides(
            Object.fromEntries(
              parsed
                .map((pub) => [pub.id, getStoredBearing(pub.id)] as const)
                .filter((entry): entry is [string, number] => entry[1] !== undefined)
            )
          );
        }
    };

    loadPubs()
      .catch(() => {
        // keep seed list
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pubsSorted = useMemo(() => {
    if (!userLocation) return pubs;
    const withD = pubs.map((p) => ({ pub: p, d: haversineDistanceM(userLocation, { lat: p.lat, lon: p.lon }) }));
    withD.sort((a, b) => a.d - b.d);
    return withD.map((x) => x.pub);
  }, [pubs, userLocation]);

  useEffect(() => {
    setBearingOverrides((current) => {
      if (Object.keys(current).length > 0) return current;
      const seeded = Object.fromEntries(
        pubs
          .map((pub) => [pub.id, getStoredBearing(pub.id)] as const)
          .filter((entry): entry is [string, number] => entry[1] !== undefined)
      );
      return Object.keys(seeded).length > 0 ? seeded : current;
    });
  }, [pubs]);

  useEffect(() => {
    if (initialRegionFocusedRef.current || pubs.length === 0) return;
    initialRegionFocusedRef.current = true;
    setRegionFocusTick((value) => value + 1);
  }, [pubs.length]);

  useEffect(() => {
    const nextRegion = regionIdForPoint(userLocation) ?? "dublin";
    setRegionId((current) => (current === nextRegion ? current : nextRegion));
    setRegionFocusTick((value) => value + 1);
  }, [userLocation]);

  useEffect(() => {
    const nextRegion = regionIdForPoint(mapViewport?.center ?? null);
    if (!nextRegion) return;
    setRegionId((current) => (current === nextRegion ? current : nextRegion));
  }, [mapViewport?.center.lat, mapViewport?.center.lon]);

  function getPubBearing(pub: Pub) {
    return bearingOverrides[pub.id] ?? pub.frontBearingDeg;
  }

  const fallbackShadeClearanceByPub = useMemo(() => {
    return new Map(
      pubs.map((pub) => {
        const nearbyPubCount = pubs.reduce((count, candidate) => {
          if (candidate.id === pub.id) return count;
          return haversineDistanceM({ lat: pub.lat, lon: pub.lon }, { lat: candidate.lat, lon: candidate.lon }) <= 180
            ? count + 1
            : count;
        }, 0);

        const base = nearbyPubCount >= 10 ? 16 : nearbyPubCount >= 6 ? 13 : nearbyPubCount >= 3 ? 10.5 : 8;
        const densityBoost = nearbyPubCount >= 12 ? 3 : nearbyPubCount >= 8 ? 1.5 : nearbyPubCount >= 4 ? 0.5 : 0;
        return [pub.id, Math.round((base + densityBoost) * 10) / 10] as const;
      })
    );
  }, [pubs]);

  function getPubShadeClearanceDeg(pub: Pub) {
    return pub.shadeClearanceDeg ?? fallbackShadeClearanceByPub.get(pub.id);
  }

  const filtered = useMemo(() => {
    const q = normalizeSearchText(query);
    const list = pubsSorted.filter((pub) => pointInRegion(getPubAnchor(pub), regionId));
    if (!q) return list;
    return list.filter((pub) => normalizeSearchText(pub.name).includes(q));
  }, [pubsSorted, query, regionId]);
  const mapPubs = useMemo(() => {
    return regionId === "all" ? pubsSorted : pubsSorted.filter((pub) => pointInRegion(getPubAnchor(pub), regionId));
  }, [pubsSorted, regionId]);
  const regionFocus = useMemo(() => getRegionFocus(regionId, pubs), [pubs, regionId]);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const [previewTime, setPreviewTime] = useState(() => initialViewRef.current.previewTime ?? new Date());
  useEffect(() => {
    setPreviewTime((current) => {
      const driftMinutes = Math.abs(current.getTime() - now.getTime()) / 60_000;
      return driftMinutes > 55 ? now : current;
    });
  }, [now]);

  const previewGrid = useMemo(() => makeTimeGrid({ start: now, minutesStep: 10, steps: 48 * 6 }), [now]);
  const previewRangeStart = previewGrid[0] ?? now;
  const previewRangeEnd = previewGrid[previewGrid.length - 1] ?? previewRangeStart;
  const previewSliderValue = getTimeSliderValue(previewTime, previewRangeStart);
  const effectivePreviewTime =
    previewSliderValue >= 0 && previewSliderValue < previewGrid.length ? previewGrid[previewSliderValue]! : previewTime;

  useEffect(() => {
    if (!showDrawer && !showTimeSlider) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchDockRef.current?.contains(target)) return;
      setShowDrawer(false);
      setShowTimeSlider(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowDrawer(false);
        setShowTimeSlider(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showDrawer, showTimeSlider]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedId) params.set("pub", selectedId);
    else params.delete("pub");
    params.set("time", effectivePreviewTime.toISOString());
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }, [effectivePreviewTime, selectedId]);
  const selectedBearing = selectedPub ? getPubBearing(selectedPub) : undefined;
  const selectedShadeClearanceDeg = selectedPub ? getPubShadeClearanceDeg(selectedPub) : undefined;
  const selectedDisplayPoint = useMemo<LatLon | undefined>(() => {
    if (!selectedPub) return undefined;
    return getPubAnchor(selectedPub);
  }, [selectedPub]);
  const selectedForecast = useMemo(() => {
    if (!selectedDisplayPoint) return forecast;
    return pickForecastForPoint(selectedDisplayPoint, viewportForecastGrid, forecast, mapViewport);
  }, [forecast, mapViewport, selectedDisplayPoint, viewportForecastGrid]);

  const pubStatus = useMemo(() => {
    if (!forecast && !viewportForecastGrid?.length) return new Map<string, "sunny" | "not" | "unknown">();
    const m = new Map<string, "sunny" | "not" | "unknown">();
    for (const pub of pubsSorted) {
      const pubForecast = pickForecastForPoint(getPubAnchor(pub), viewportForecastGrid, forecast, mapViewport);
      if (!pubForecast) {
        m.set(pub.id, "unknown");
        continue;
      }
      const bearing = getPubBearing(pub);
      const nearestHours =
        bearing !== undefined
          ? computeFrontSunnyHours({
              pub,
              forecast: pubForecast,
              frontBearingDegOverride: bearing,
              minSunAltitudeDeg: getPubShadeClearanceDeg(pub)
            })
          : computeGeneralSunnyHours({ pub, forecast: pubForecast, minSunAltitudeDeg: getPubShadeClearanceDeg(pub) });
      const nearest = nearestHours.reduce<{
        best: ReturnType<typeof computeFrontSunnyHours>[number] | null;
        dt: number;
      }>(
        (acc, h) => {
          const dt = Math.abs(h.time.getTime() - effectivePreviewTime.getTime());
          if (!acc.best || dt < acc.dt) return { best: h, dt };
          return acc;
        },
        { best: null, dt: Number.POSITIVE_INFINITY }
      ).best;
      if (!nearest) m.set(pub.id, "unknown");
      else m.set(pub.id, nearest.isFrontSunny ? "sunny" : "not");
    }
    return m;
  }, [bearingOverrides, effectivePreviewTime, forecast, mapViewport, pubsSorted, viewportForecastGrid]);

  const selectedIntervals = useMemo(() => {
    if (!selectedPub || !selectedForecast) return null;
    const times = makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 });
    const samples =
      selectedBearing !== undefined
        ? computeFrontSunnySamples({
            pub: selectedPub,
            forecast: selectedForecast,
            times,
            frontBearingDegOverride: selectedBearing,
            minSunAltitudeDeg: selectedShadeClearanceDeg
          })
        : computeGeneralSunnySamples({
            pub: selectedPub,
            forecast: selectedForecast,
            times,
            minSunAltitudeDeg: selectedShadeClearanceDeg
          });
    return sunnyIntervalsFromHours(samples);
  }, [effectivePreviewTime, selectedBearing, selectedForecast, selectedPub, selectedShadeClearanceDeg]);

  const userLocationIntervals = useMemo(() => {
    if (!userLocation || !userForecast) return null;
    const times = makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 });
    const samples = computeGeneralSunnySamples({
      pub: {
        id: "user-location",
        name: "Your location",
        lat: userLocation.lat,
        lon: userLocation.lon
      },
      forecast: userForecast,
      times
    });
    return sunnyIntervalsFromHours(samples);
  }, [effectivePreviewTime, userForecast, userLocation]);

  const userLocationStatus = useMemo<"sunny" | "not" | "unknown">(() => {
    if (!userLocation || !userForecast) return "unknown";
    const hours = computeGeneralSunnyHours({
      pub: {
        id: "user-location",
        name: "Your location",
        lat: userLocation.lat,
        lon: userLocation.lon
      },
      forecast: userForecast
    });
    const nearest = hours.reduce<{ best: (typeof hours)[number] | null; dt: number }>(
      (acc, hour) => {
        const dt = Math.abs(hour.time.getTime() - effectivePreviewTime.getTime());
        if (!acc.best || dt < acc.dt) return { best: hour, dt };
        return acc;
      },
      { best: null, dt: Number.POSITIVE_INFINITY }
    ).best;
    if (!nearest) return "unknown";
    return nearest.isFrontSunny ? "sunny" : "not";
  }, [effectivePreviewTime, userForecast, userLocation]);

  const sunChasePlan = useMemo(() => {
    if (!showSunChase || !selectedPub || !selectedDisplayPoint || (!forecast && !viewportForecastGrid?.length)) return null;

    const candidatePubs = [
      selectedPub,
      ...pubs
        .filter((pub) => pub.id !== selectedPub.id)
        .sort((a, b) => {
          const distA = haversineDistanceM(selectedDisplayPoint, getPubAnchor(a));
          const distB = haversineDistanceM(selectedDisplayPoint, getPubAnchor(b));
          return distA - distB;
        })
        .slice(0, SUN_CHASE_CANDIDATE_LIMIT)
    ];

    const candidateData = candidatePubs
      .map((pub) => {
        const anchor = getPubAnchor(pub);
        const candidateForecast = pickForecastForPoint(anchor, viewportForecastGrid, forecast, mapViewport);
        if (!candidateForecast) {
          return {
            pub,
            anchor,
            intervals: []
          };
        }
        const bearing = getPubBearing(pub);
        const intervals =
          pub.id === selectedPub.id && selectedIntervals
            ? selectedIntervals
            : sunnyIntervalsFromHours(
                bearing !== undefined
                  ? computeFrontSunnySamples({
                      pub,
                      forecast: candidateForecast,
                      times: makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 }),
                      frontBearingDegOverride: bearing,
                      minSunAltitudeDeg: getPubShadeClearanceDeg(pub)
                    })
                  : computeGeneralSunnySamples({
                      pub,
                      forecast: candidateForecast,
                      times: makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 }),
                      minSunAltitudeDeg: getPubShadeClearanceDeg(pub)
                    })
              );
        return {
          pub,
          anchor,
          intervals: intervals.filter((interval) => interval.end.getTime() > effectivePreviewTime.getTime())
        };
      })
      .filter((candidate) => candidate.intervals.length > 0);

    const findBestStop = (
      from: LatLon,
      earliestMs: number,
      candidates: typeof candidateData
    ) => {
      let best:
        | (SunChaseStop & {
            sunnyStartMs: number;
          })
        | null = null;

      for (const candidate of candidates) {
        const distanceM = haversineDistanceM(from, candidate.anchor);
        const walkMinutes = estimateWalkingMinutes(distanceM);
        const arrivalMs = earliestMs + walkMinutes * 60_000;

        for (const interval of candidate.intervals) {
          const startMs = interval.start.getTime();
          const endMs = interval.end.getTime();
          const sunnyStartMs = Math.max(arrivalMs, startMs);
          if (endMs - sunnyStartMs < SUN_CHASE_MIN_STOP_MINUTES * 60_000) continue;

          const nextStop: SunChaseStop & { sunnyStartMs: number } = {
            pub: candidate.pub,
            anchor: candidate.anchor,
            interval,
            sunnyStart: new Date(sunnyStartMs),
            walkMinutesFromPrev: walkMinutes,
            distanceMFromPrev: distanceM,
            sunnyStartMs
          };

          if (
            !best ||
            sunnyStartMs < best.sunnyStartMs ||
            (sunnyStartMs === best.sunnyStartMs && walkMinutes < best.walkMinutesFromPrev)
          ) {
            best = nextStop;
          }
          break;
        }
      }

      return best;
    };

    const used = new Set<string>();
    const stops: SunChaseStop[] = [];
    const origin = userLocation ?? selectedDisplayPoint;
    let currentPoint = origin;
    let currentReadyMs = effectivePreviewTime.getTime();

    const selectedCandidate = candidateData.find((candidate) => candidate.pub.id === selectedPub.id);
    if (selectedCandidate) {
      const firstStop = findBestStop(origin, currentReadyMs, [selectedCandidate]);
      if (firstStop) {
        used.add(firstStop.pub.id);
        stops.push(firstStop);
        currentPoint = firstStop.anchor;
        currentReadyMs = firstStop.sunnyStart.getTime() + SUN_CHASE_MIN_STOP_MINUTES * 60_000;
      }
    }

    while (stops.length < SUN_CHASE_STOP_LIMIT) {
      const remaining = candidateData.filter((candidate) => !used.has(candidate.pub.id));
      const nextStop = findBestStop(currentPoint, currentReadyMs, remaining);
      if (!nextStop) break;
      used.add(nextStop.pub.id);
      stops.push(nextStop);
      currentPoint = nextStop.anchor;
      currentReadyMs = nextStop.sunnyStart.getTime() + SUN_CHASE_MIN_STOP_MINUTES * 60_000;
    }

    if (stops.length < 2) return null;

    const adjustedStops = stops.map((stop) => ({ ...stop }));

    if (userLocation && adjustedStops.length) {
      const first = adjustedStops[0]!;
      const targetLeaveMs = first.sunnyStart.getTime() - first.walkMinutesFromPrev * 60_000;
      first.departAt = new Date(Math.max(effectivePreviewTime.getTime(), targetLeaveMs));
    }

    for (let index = 0; index < adjustedStops.length - 1; index++) {
      const current = adjustedStops[index]!;
      const next = adjustedStops[index + 1]!;
      const earliestLeaveMs = current.sunnyStart.getTime() + SUN_CHASE_MIN_STOP_MINUTES * 60_000;
      const desiredLeaveMs = next.sunnyStart.getTime() - next.walkMinutesFromPrev * 60_000;
      current.departAt = new Date(Math.max(earliestLeaveMs, Math.min(current.interval.end.getTime(), desiredLeaveMs)));
    }

    const routeStops = userLocation
      ? adjustedStops.map((stop) => stop.anchor)
      : adjustedStops
          .filter((stop, index) => !(index === 0 && stop.pub.id === selectedPub.id))
          .map((stop) => stop.anchor);

    return {
      stops: adjustedStops,
      googleMapsUrl: buildGoogleMapsWalkingUrl(origin, routeStops),
      originIsUserLocation: Boolean(userLocation)
    };
  }, [
    effectivePreviewTime,
    forecast,
    mapViewport,
    pubs,
    selectedDisplayPoint,
    selectedIntervals,
    selectedPub,
    showSunChase,
    userLocation,
    viewportForecastGrid
  ]);

  const selectedSunBearing = useMemo(() => {
    if (!selectedPub) return undefined;
    const pos = SunCalc.getPosition(effectivePreviewTime, selectedPub.lat, selectedPub.lon);
    return ((pos.azimuth * 180) / Math.PI + 180 + 360) % 360;
  }, [effectivePreviewTime, selectedPub]);

  useEffect(() => {
    if (!selectedPub) {
      setSelectedAddress(null);
      setSelectedAddressLoading(false);
      return;
    }

    const lookupPoint = selectedDisplayPoint ?? { lat: selectedPub.lat, lon: selectedPub.lon };

    const cacheKey = `address:${selectedPub.id}`;
    const cached = readCachedJson<string>(cacheKey);
    if (cached) {
      setSelectedAddress(cached);
      setSelectedAddressLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedAddress(null);
    setSelectedAddressLoading(true);

    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lookupPoint.lat}&lon=${lookupPoint.lon}&zoom=18&addressdetails=1`
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const json = (await response.json()) as {
          display_name?: string;
          address?: Record<string, string>;
        };
        const address = json.address;
        const parts = address
          ? [
              address.house_number,
              address.road,
              address.suburb ?? address.neighbourhood,
              address.city ?? address.town ?? address.village ?? "Ireland"
            ].filter(Boolean)
          : [];
        const label =
          parts.length
            ? parts.join(", ")
            : json.display_name ?? `${lookupPoint.lat.toFixed(5)}, ${lookupPoint.lon.toFixed(5)}`;
        if (!cancelled) {
          setSelectedAddress(label);
          setSelectedAddressLoading(false);
          writeCachedJson(cacheKey, label, ADDRESS_CACHE_MS);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedAddress(`${lookupPoint.lat.toFixed(5)}, ${lookupPoint.lon.toFixed(5)}`);
          setSelectedAddressLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDisplayPoint, selectedPub]);

  const googleMapsUrl = useMemo(() => {
    if (!selectedPub) return "#";
    const destinationPoint = selectedDisplayPoint ?? { lat: selectedPub.lat, lon: selectedPub.lon };
    const destination = `${destinationPoint.lat},${destinationPoint.lon}`;
    if (userLocation) {
      const origin = `${userLocation.lat},${userLocation.lon}`;
      return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=walking`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination)}`;
  }, [selectedDisplayPoint, selectedPub, userLocation]);

  const pubPopover = selectedPub ? (
    <section className="mapPopoverCard" aria-label="Selected pub details">
      <div className="overlayHeader">
        <div>
          <h2>{selectedPub.name}</h2>
          <div className="sub">
            {selectedAddressLoading ? "Looking up address…" : selectedAddress ?? `${selectedPub.lat.toFixed(5)}, ${selectedPub.lon.toFixed(5)}`}
          </div>
        </div>
        <div className="overlayActions">
          <button
            type="button"
            className={`iconBtn sunChaseIconBtn ${showSunChase ? "active" : ""}`}
            onClick={() => setShowSunChase((value) => !value)}
            aria-label="Follow the sun"
            title="Follow the sun"
          >
            <MaterialIcon name="sunny" />
          </button>
          <a className="iconBtn iconBtnLink" href={googleMapsUrl} target="_blank" rel="noreferrer" aria-label="Get directions" title="Directions">
            <MaterialIcon name="directions" />
          </a>
        </div>
      </div>
      <div className="overlayBody">
        {!selectedForecast ? (
          <div className="popoverStatusText">Loading forecast…</div>
        ) : selectedIntervals && selectedIntervals.length ? (
          <div className="row">
            <div className="label">Next sunny times</div>
            <div className="times">
              {selectedIntervals.slice(0, 6).map((it) => (
                <div className="timeChip" key={it.start.toISOString()}>
                  <span>
                    <strong>{formatDublinTime(it.start)}</strong> → {formatDublinTime(it.end)}
                  </span>
                  <button
                    type="button"
                    className="pill sunny pillButton"
                    onClick={() => {
                      setPreviewTime(new Date(it.start));
                      setShowTimeSlider(false);
                      setShowDrawer(false);
                    }}
                    aria-label={`Jump preview time to ${formatDublinTime(it.start)}`}
                    title={`Jump to ${formatDublinTime(it.start)}`}
                  >
                    sunny
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="popoverStatusText">No sunny windows in next 48h</div>
        )}
      </div>
    </section>
  ) : null;

  const userLocationPopover = showUserLocationPopover && userLocation ? (
    <section className="mapPopoverCard" aria-label="Your location details">
      <div className="overlayHeader">
        <div>
          <h2>Your location</h2>
          <div className="sub">
            {userLocation.lat.toFixed(5)}, {userLocation.lon.toFixed(5)}
          </div>
        </div>
      </div>
      <div className="overlayBody">
        {!userForecast ? (
          <div className="popoverStatusText">
            {userForecastError ? "Couldn’t load local forecast right now." : "Loading local forecast…"}
          </div>
        ) : userLocationIntervals && userLocationIntervals.length ? (
          <div className="row">
            <div className="label">Next sunny times</div>
            <div className="times">
              {userLocationIntervals.slice(0, 6).map((it) => (
                <div className="timeChip" key={it.start.toISOString()}>
                  <span>
                    <strong>{formatDublinTime(it.start)}</strong> → {formatDublinTime(it.end)}
                  </span>
                  <button
                    type="button"
                    className="pill sunny pillButton"
                    onClick={() => {
                      setPreviewTime(new Date(it.start));
                      setShowTimeSlider(false);
                      setShowDrawer(false);
                    }}
                    aria-label={`Jump preview time to ${formatDublinTime(it.start)}`}
                    title={`Jump to ${formatDublinTime(it.start)}`}
                  >
                    sunny
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="popoverStatusText">No sunny windows in next 48h</div>
        )}
      </div>
    </section>
  ) : null;

  const activePopover = showUserLocationPopover ? userLocationPopover : pubPopover;
  const activePopoverAnchor = showUserLocationPopover ? userLocation ?? undefined : selectedDisplayPoint;
  const sunChaseModal =
    showSunChase && selectedPub ? (
      <aside className="sunChaseModal" aria-label="Follow the sun route">
        <div className="sunChaseModalHeader">
          <div>
            <div className="sunChaseModalEyebrow">Follow the sun</div>
            <h3>{selectedPub.name}</h3>
          </div>
          <button
            type="button"
            className="iconBtn"
            onClick={() => setShowSunChase(false)}
            aria-label="Close follow the sun panel"
            title="Close"
          >
            <MaterialIcon name="close" />
          </button>
        </div>
        {sunChasePlan ? (
          <div className="sunChasePlan">
            <div className="sunChaseHeader">
              <span>Sunny pub route</span>
              {sunChasePlan.googleMapsUrl ? (
                <a
                  className="sunChaseRouteBtn"
                  href={sunChasePlan.googleMapsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MaterialIcon name="directions" size={14} />
                  <span>Open route</span>
                </a>
              ) : null}
            </div>
            <div className="sunChaseStops">
              {sunChasePlan.stops.map((stop, index) => (
                <div className="sunChaseStop" key={`${stop.pub.id}-${stop.interval.start.toISOString()}`}>
                  <div className="sunChaseStopTop">
                    <span className="sunChaseIndex">{index + 1}</span>
                    <span className="sunChaseName">{stop.pub.name}</span>
                  </div>
                  <div className="sunChaseMeta">
                    <strong>{formatDublinTime(stop.sunnyStart)}</strong> → {formatDublinTime(stop.interval.end)}
                  </div>
                  <div className="sunChaseMeta">
                    {index === 0
                      ? `${sunChasePlan.originIsUserLocation ? `Leave ${formatDublinTime(stop.departAt ?? effectivePreviewTime)}` : "Start here"} · ${stop.walkMinutesFromPrev} min walk`
                      : `Leave ${formatDublinTime(sunChasePlan.stops[index - 1]!.departAt ?? effectivePreviewTime)} · ${stop.walkMinutesFromPrev} min walk`}
                  </div>
                </div>
              ))}
            </div>
            <div className="finePrint">Google Maps opens the walking route. Leave times stay in the app.</div>
          </div>
        ) : (
          <div className="sunChaseEmpty">Couldn’t build a multi-pub sunny route right now.</div>
        )}
      </aside>
    ) : null;

  const filteredPanelPubs = useMemo(() => {
    return (
      quickFilter === "sunny"
        ? filtered.filter((pub) => pubStatus.get(pub.id) === "sunny")
        : filtered
    );
  }, [filtered, pubStatus, quickFilter]);

  function updatePreviewFromDrag(nextSliderValue: number) {
    const clampedValue = Math.max(0, Math.min(Math.max(0, previewGrid.length - 1), nextSliderValue));
    const next = previewGrid[clampedValue];
    if (next) setPreviewTime(next);
  }

  function handleTimePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    timeDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startSliderValue: previewSliderValue,
      moved: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleTimePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = timeDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) >= 4) {
      drag.moved = true;
      if (!isDraggingTime) setIsDraggingTime(true);
    }
    if (!drag.moved) return;

    const stepDelta = Math.round(deltaX / 12);
    updatePreviewFromDrag(drag.startSliderValue + stepDelta);
  }

  function handleTimePointerEnd(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = timeDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressTimeClickRef.current = drag.moved;
    timeDragStateRef.current = null;
    if (isDraggingTime) setIsDraggingTime(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  async function handleUseMyLocation() {
    if (userLocation) {
      setUserRecenterTick((value) => value + 1);
      return;
    }
    setLocError(null);
    try {
      const loc = await requestUserLocation();
      setUserLocation(loc);
      writeJson("user-location", loc);
      setUserRecenterTick((value) => value + 1);
    } catch (e: unknown) {
      setLocError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleSelectPub(id: string) {
    setSelectedId(id);
    setShowUserLocationPopover(false);
    setShowSunChase(false);
  }

  function handleSelectUserLocation() {
    if (!userLocation) return;
    setSelectedId(null);
    setShowUserLocationPopover(true);
    setShowSunChase(false);
    setShowDrawer(false);
    setShowTimeSlider(false);
    setUserRecenterTick((value) => value + 1);
  }

  function handleSearchActivate() {
    setShowDrawer(true);
    setShowTimeSlider(false);
  }

  function handleTimeChipClick() {
    if (suppressTimeClickRef.current) {
      suppressTimeClickRef.current = false;
      return;
    }
    setShowDrawer(false);
    setShowTimeSlider((value) => !value);
  }

  return (
    <div className="app">
      <main className="mapWrap">
        <Suspense fallback={<div className="mapSkeleton">Loading map...</div>}>
          <PubMap
            pubs={mapPubs}
            selectedPub={selectedPub}
            selectedAnchor={selectedDisplayPoint}
            popoverAnchor={activePopoverAnchor}
            selectedRecenterTick={selectedRecenterTick}
            onClosePopover={() => {
              setSelectedId(null);
              setShowUserLocationPopover(false);
              setShowSunChase(false);
            }}
            onSelect={handleSelectPub}
            onSelectUserLocation={handleSelectUserLocation}
            status={pubStatus}
            selectedPopover={activePopover}
            userLocation={userLocation}
            userLocationStatus={userLocationStatus}
            userRecenterTick={userRecenterTick}
            regionFocus={regionFocus}
            regionFocusTick={regionFocusTick}
            selectedSunBearingDeg={selectedSunBearing}
            selectedFrontBearingDeg={selectedBearing}
            onViewportChange={setMapViewport}
          />
        </Suspense>
        <section className="topPanel">
          <div className="topPanelToolbar">
            <div className="searchDock" ref={searchDockRef}>
              <div className={`toolbarSearchUnified ${isDraggingTime ? "dragging" : ""}`} aria-label="Search pubs and time">
                <button
                  className="toolbarSunnyLead"
                  onClick={() => {
                    searchInputRef.current?.focus();
                    handleSearchActivate();
                  }}
                  aria-label="Focus pub search"
                  title="Search sunny pubs"
                >
                  <MaterialIcon name="sunny" size={20} />
                </button>
                <input
                  ref={searchInputRef}
                  className="toolbarSearchInput"
                  type="text"
                  value={query}
                  onFocus={handleSearchActivate}
                  onClick={handleSearchActivate}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    handleSearchActivate();
                  }}
                  placeholder="search for sunny pubs"
                  aria-label="Search pubs"
                />
                <span className="toolbarAtLabel">in</span>
                <label className="toolbarRegionWrap">
                  <span className="srOnly">Select region</span>
                  <select
                    className="toolbarRegionSelect"
                    value={regionId}
                    onChange={(e) => {
                      setRegionId(e.target.value as (typeof REGION_OPTIONS)[number]["id"]);
                      setRegionFocusTick((value) => value + 1);
                      handleSearchActivate();
                    }}
                    aria-label="Select region"
                  >
                    {REGION_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="toolbarAtLabel">at</span>
                <button
                  className="toolbarInlineTime toolbarTimeDraggable"
                  onPointerDown={handleTimePointerDown}
                  onPointerMove={handleTimePointerMove}
                  onPointerUp={handleTimePointerEnd}
                  onPointerCancel={handleTimePointerEnd}
                  onClick={handleTimeChipClick}
                  title="Click to open time slider, drag to scrub"
                  aria-label="Open preview time slider or drag to scrub"
                  aria-expanded={showTimeSlider}
                >
                  {formatDublinTime(effectivePreviewTime)}
                </button>
              </div>
              {showTimeSlider ? (
                <div className="timeSliderPopover" aria-label="Preview time slider">
                  <div className="timeSliderHeader">
                    <span className="timeSliderLabel">Preview time</span>
                    <span className="timeSliderValue">{formatDublinTime(effectivePreviewTime)}</span>
                  </div>
                  <input
                    className="timeSliderInput"
                    type="range"
                    min={0}
                    max={Math.max(0, previewGrid.length - 1)}
                    value={previewSliderValue}
                    onChange={(e) => updatePreviewFromDrag(Number(e.target.value))}
                    aria-label="Adjust preview time"
                  />
                  <div className="timeSliderScale" aria-hidden="true">
                    <span>{formatDublinTime(previewRangeStart)}</span>
                    <span>{formatDublinTime(previewRangeEnd)}</span>
                  </div>
                </div>
              ) : null}
              {showDrawer ? (
                <aside className="searchPanel" aria-label="Pub search results">
                  <div className="searchPanelHeader">
                    <div className="filterChips drawerFilters">
                      <button className={`chip ${quickFilter === "all" ? "active" : ""}`} onClick={() => setQuickFilter("all")}>
                        All
                      </button>
                      <button className={`chip ${quickFilter === "sunny" ? "active" : ""}`} onClick={() => setQuickFilter("sunny")}>
                        Sunny
                      </button>
                    </div>
                  </div>
                  <div className="searchResults">
                    {filteredPanelPubs.length ? (
                      filteredPanelPubs.map((pub) => {
                        const status = pubStatus.get(pub.id) ?? "unknown";
                        const distM = userLocation ? haversineDistanceM(userLocation, { lat: pub.lat, lon: pub.lon }) : null;
                        return (
                          <button
                            key={pub.id}
                            className={`searchResultRow ${pub.id === selectedId ? "active" : ""}`}
                            onClick={() => {
                              handleSelectPub(pub.id);
                              setShowDrawer(false);
                            }}
                          >
                            <span className={`searchResultIcon ${status === "sunny" ? "sunny" : status === "not" ? "cloudy" : "unknown"}`}>
                              <MaterialIcon name="sports_bar" size={20} />
                            </span>
                            <span className="searchResultText">
                              <span className="searchResultTitle">{pub.name}</span>
                              <span className="searchResultMeta">
                                {distM !== null ? `${(distM / 1000).toFixed(2)} km away` : "Use my location to show distance"}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="searchEmptyState">
                        {quickFilter === "sunny" ? "No pubs with sun on their doors right now" : "No pubs match that search right now."}
                      </div>
                    )}
                  </div>
                </aside>
              ) : null}
            </div>
          </div>
          {(locError || error || (!forecast && viewportForecastError)) ? (
            <div className="topPanelError floatingNotice">
              {locError ?? error ?? viewportForecastError}
            </div>
          ) : null}
        </section>

        <div className="mapInfoDock">
          <button
            className="mapInfoButton"
            onClick={handleUseMyLocation}
            aria-label="Use my location"
            title="Use my location"
          >
            <MaterialIcon name="my_location" />
          </button>
        </div>
        {sunChaseModal}
      </main>
    </div>
  );
}
