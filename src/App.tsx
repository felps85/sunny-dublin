import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import SunCalc from "suncalc";
import { SEED_PUBS } from "./data/pubs";
import type { ForecastHour, LatLon, Pub } from "./types";
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

const DUBLIN_CENTER = { lat: 53.3498, lon: -6.2603 };
const PubMap = lazy(() => import("./components/PubMap"));
const FORECAST_CACHE_MS = 15 * 60_000;
const ADDRESS_CACHE_MS = 7 * 24 * 60 * 60_000;

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

function useForecast(hours: number, refreshKey: number) {
  const [data, setData] = useState<ForecastHour[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `forecast:${DUBLIN_CENTER.lat}:${DUBLIN_CENTER.lon}:${hours}`;
    const cachedRaw = refreshKey === 0 ? readCachedJson<ForecastHour[]>(cacheKey) : undefined;
    const cached = cachedRaw ? normalizeForecastRows(cachedRaw) : undefined;
    setError(null);
    setData(cached ?? null);
    fetchForecastHourly({ lat: DUBLIN_CENTER.lat, lon: DUBLIN_CENTER.lon, hours })
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
  }, [hours, refreshKey]);

  return { data, error };
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

export default function App() {
  const initialViewRef = useRef(parseInitialView());
  const [query, setQuery] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);
  const [quickFilter, setQuickFilter] = useState<"all" | "sunny">("all");
  const [pubs, setPubs] = useState<Pub[]>(SEED_PUBS);
  const [selectedId, setSelectedId] = useState<string | null>(initialViewRef.current.selectedId ?? null);
  const [showUserLocationPopover, setShowUserLocationPopover] = useState(false);
  const [selectedRecenterTick, setSelectedRecenterTick] = useState(0);
  const [userRecenterTick, setUserRecenterTick] = useState(0);
  const [bearingOverrides, setBearingOverrides] = useState<Record<string, number>>({});
  const selectedPub = useMemo(() => pubs.find((p) => p.id === selectedId) ?? null, [pubs, selectedId]);

  const [forecastRefresh, setForecastRefresh] = useState(0);
  const { data: forecast, error } = useForecast(48, forecastRefresh);

  const [userLocation, setUserLocation] = useState<LatLon | null>(() => readStoredUserLocation());
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
    fetch("/pubs.json")
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const json = (await r.json()) as unknown;
        if (!Array.isArray(json)) throw new Error("pubs.json is not an array");

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
      })
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

  function getPubBearing(pub: Pub) {
    return bearingOverrides[pub.id] ?? pub.frontBearingDeg;
  }

  const fallbackShadeClearanceByPub = useMemo(() => {
    return new Map(
      pubs.map((pub) => {
        const centerDistanceM = haversineDistanceM({ lat: pub.lat, lon: pub.lon }, DUBLIN_CENTER);
        const nearbyPubCount = pubs.reduce((count, candidate) => {
          if (candidate.id === pub.id) return count;
          return haversineDistanceM({ lat: pub.lat, lon: pub.lon }, { lat: candidate.lat, lon: candidate.lon }) <= 180
            ? count + 1
            : count;
        }, 0);

        const base =
          centerDistanceM < 1200 ? 20 : centerDistanceM < 2500 ? 16 : centerDistanceM < 4500 ? 12 : centerDistanceM < 7000 ? 9 : 7;
        const densityBoost = nearbyPubCount >= 10 ? 4 : nearbyPubCount >= 6 ? 2.5 : nearbyPubCount >= 3 ? 1 : 0;
        return [pub.id, Math.round((base + densityBoost) * 10) / 10] as const;
      })
    );
  }, [pubs]);

  function getPubShadeClearanceDeg(pub: Pub) {
    return pub.shadeClearanceDeg ?? fallbackShadeClearanceByPub.get(pub.id);
  }

  const filtered = useMemo(() => {
    const q = normalizeSearchText(query);
    const list = pubsSorted;
    if (!q) return list;
    return list.filter((pub) => normalizeSearchText(pub.name).includes(q));
  }, [pubsSorted, query]);

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
    if (selectedPub.displayLat !== undefined && selectedPub.displayLon !== undefined) {
      return { lat: selectedPub.displayLat, lon: selectedPub.displayLon };
    }
    return { lat: selectedPub.lat, lon: selectedPub.lon };
  }, [selectedPub]);

  const pubStatus = useMemo(() => {
    if (!forecast) return new Map<string, "sunny" | "not" | "unknown">();
    const m = new Map<string, "sunny" | "not" | "unknown">();
    for (const pub of pubsSorted) {
      const bearing = getPubBearing(pub);
      const nearestHours =
        bearing !== undefined
          ? computeFrontSunnyHours({
              pub,
              forecast,
              frontBearingDegOverride: bearing,
              minSunAltitudeDeg: getPubShadeClearanceDeg(pub)
            })
          : computeGeneralSunnyHours({ pub, forecast, minSunAltitudeDeg: getPubShadeClearanceDeg(pub) });
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
  }, [bearingOverrides, effectivePreviewTime, forecast, pubsSorted]);

  const selectedIntervals = useMemo(() => {
    if (!selectedPub || !forecast) return null;
    const times = makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 });
    const samples =
      selectedBearing !== undefined
        ? computeFrontSunnySamples({
            pub: selectedPub,
            forecast,
            times,
            frontBearingDegOverride: selectedBearing,
            minSunAltitudeDeg: selectedShadeClearanceDeg
          })
        : computeGeneralSunnySamples({
            pub: selectedPub,
            forecast,
            times,
            minSunAltitudeDeg: selectedShadeClearanceDeg
          });
    return sunnyIntervalsFromHours(samples);
  }, [effectivePreviewTime, forecast, selectedBearing, selectedPub, selectedShadeClearanceDeg]);

  const userLocationIntervals = useMemo(() => {
    if (!userLocation || !forecast) return null;
    const times = makeTimeGrid({ start: effectivePreviewTime, minutesStep: 10, steps: 48 * 6 });
    const samples = computeGeneralSunnySamples({
      pub: {
        id: "user-location",
        name: "Your location",
        lat: userLocation.lat,
        lon: userLocation.lon
      },
      forecast,
      times
    });
    return sunnyIntervalsFromHours(samples);
  }, [effectivePreviewTime, forecast, userLocation]);

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
              address.city ?? address.town ?? address.village ?? "Dublin"
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
          <a className="iconBtn iconBtnLink" href={googleMapsUrl} target="_blank" rel="noreferrer" aria-label="Get directions" title="Directions">
            <MaterialIcon name="directions" />
          </a>
        </div>
      </div>
      <div className="overlayBody">
        {!forecast ? (
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
        {!forecast ? (
          <div className="popoverStatusText">Loading forecast…</div>
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
  }

  function handleSelectUserLocation() {
    if (!userLocation) return;
    setSelectedId(null);
    setShowUserLocationPopover(true);
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
            pubs={pubsSorted}
            selectedPub={selectedPub}
            selectedAnchor={selectedDisplayPoint}
            popoverAnchor={activePopoverAnchor}
            selectedRecenterTick={selectedRecenterTick}
            onClosePopover={() => {
              setSelectedId(null);
              setShowUserLocationPopover(false);
            }}
            onSelect={handleSelectPub}
            onSelectUserLocation={handleSelectUserLocation}
            status={pubStatus}
            selectedPopover={activePopover}
            userLocation={userLocation}
            userRecenterTick={userRecenterTick}
            selectedSunBearingDeg={selectedSunBearing}
            selectedFrontBearingDeg={selectedBearing}
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
                  placeholder="search for sunny pubs in Dublin"
                  aria-label="Search pubs"
                />
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
                      <div className="searchEmptyState">No pubs match that search right now.</div>
                    )}
                  </div>
                </aside>
              ) : null}
            </div>
          </div>
          {(locError || error) ? (
            <div className="topPanelError floatingNotice">
              {locError ?? error}
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
      </main>
    </div>
  );
}
