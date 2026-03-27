import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { materialIconPath } from "./MaterialIcon";
import type { LatLon, Pub } from "../types";

const FALLBACK_BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    cartoLight: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  },
  layers: [
    {
      id: "carto-light",
      type: "raster",
      source: "cartoLight"
    }
  ]
};

export default function PubMap(props: {
  pubs: Pub[];
  selectedPub?: Pub | null;
  selectedAnchor?: LatLon;
  popoverAnchor?: LatLon;
  selectedRecenterTick?: number;
  onClosePopover?: () => void;
  onSelect: (id: string) => void;
  onSelectUserLocation?: () => void;
  status: Map<string, "sunny" | "not" | "unknown">;
  selectedPopover?: React.ReactNode;
  userLocation?: { lat: number; lon: number } | null;
  userRecenterTick?: number;
  selectedSunBearingDeg?: number;
  selectedFrontBearingDeg?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const latestPropsRef = useRef(props);
  const selectedPub = props.selectedPub ?? null;
  latestPropsRef.current = props;
  const [popoverPlacement, setPopoverPlacement] = useState<"above" | "below">("above");
  const [popoverStyle, setPopoverStyle] = useState<{ left: number; top: number } | null>(null);

  const pubPinFeatures = useMemo(() => {
    const pubsById = new Map(props.pubs.map((pub) => [pub.id, pub]));
    if (selectedPub) pubsById.set(selectedPub.id, selectedPub);

    return Array.from(pubsById.values()).map((pub) => {
      const isSelected = selectedPub?.id === pub.id;
      const anchor = isSelected && props.selectedAnchor ? props.selectedAnchor : getPubAnchorLatLon(pub);
      const status = props.status.get(pub.id) ?? "unknown";
      return {
        type: "Feature" as const,
        properties: {
          id: pub.id,
          icon: getPubPinIconName(status, isSelected),
          selected: isSelected ? 1 : 0
        },
        geometry: {
          type: "Point" as const,
          coordinates: [anchor.lon, anchor.lat]
        }
      };
    });
  }, [props.pubs, props.selectedAnchor, props.status, selectedPub]);

  const updateSelectedPopoverPosition = useCallback(() => {
    const map = mapRef.current;
    const activeAnchor = props.popoverAnchor ?? (selectedPub ? props.selectedAnchor ?? getPubAnchorLatLon(selectedPub) : undefined);
    if (!map || !activeAnchor || !props.selectedPopover) {
      setPopoverStyle(null);
      return;
    }

    const point = map.project([activeAnchor.lon, activeAnchor.lat]);
    const mapRect = map.getContainer().getBoundingClientRect();
    const topPanel = document.querySelector(".topPanel");
    const reservedTop = topPanel ? topPanel.getBoundingClientRect().bottom - mapRect.top + 12 : 96;
    const cardWidth = popoverRef.current?.offsetWidth ?? 320;
    const cardHeight = popoverRef.current?.offsetHeight ?? 190;
    const margin = 18;
    const pinTopY = point.y - 18;
    const left = clamp(point.x, cardWidth / 2 + margin, mapRect.width - cardWidth / 2 - margin);
    const canFitAbove = pinTopY - cardHeight - 18 >= reservedTop;
    const placement = canFitAbove ? "above" : "below";
    const top = canFitAbove
      ? Math.max(reservedTop + cardHeight, pinTopY - 12)
      : Math.min(mapRect.height - cardHeight - margin, point.y + 18);

    setPopoverPlacement(placement);
    setPopoverStyle({ left, top });
  }, [props.popoverAnchor, props.selectedAnchor, props.selectedPopover, selectedPub]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: FALLBACK_BASEMAP_STYLE,
      center: [-6.2603, 53.3498],
      zoom: 13,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    map.on("load", () => {
      ensurePubPinImages(map);
      ensureUserLocationImage(map);
      ensureOverlayLayers(map);
      ensurePubPinLayers(map);
      ensureUserLocationLayer(map);
      syncPubPinSource(map, buildFeatureCollection(pubPinFeatures));
      syncUserLocationSource(map, props.userLocation);
      registerPubPinInteractions(map, latestPropsRef);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    ensurePubPinImages(map);
    ensureUserLocationImage(map);
    ensurePubPinLayers(map);
    ensureUserLocationLayer(map);
    syncPubPinSource(map, buildFeatureCollection(pubPinFeatures));
    syncUserLocationSource(map, props.userLocation);
  }, [props.userLocation, pubPinFeatures]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedPub) return;
    const selectedAnchor = props.selectedAnchor ?? getPubAnchorLatLon(selectedPub);
    const width = map.getContainer().clientWidth;
    const height = map.getContainer().clientHeight;
    const rightPadding = Math.max(24, Math.min(360, Math.round(width * 0.22)));
    const topPadding = Math.max(84, Math.min(120, Math.round(height * 0.14)));
    map.easeTo({
      center: [selectedAnchor.lon, selectedAnchor.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 450,
      padding: { top: topPadding, right: rightPadding, bottom: 40, left: 40 }
    });
  }, [props.selectedAnchor, props.selectedRecenterTick, selectedPub]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.selectedPopover) {
      setPopoverStyle(null);
      return;
    }

    const update = () => {
      updateSelectedPopoverPosition();
    };

    update();
    map.on("move", update);
    map.on("resize", update);
    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      map.off("move", update);
      map.off("resize", update);
    };
  }, [props.selectedPopover, updateSelectedPopoverPosition]);

  useEffect(() => {
    if (!props.selectedPopover || !props.onClosePopover) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      props.onClosePopover?.();
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [props.onClosePopover, props.selectedPopover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource("sun-guide") as maplibregl.GeoJSONSource | undefined;
    if (!source || !selectedPub) return;

    const features: GeoJSON.Feature[] = [];
    const selectedAnchor = props.selectedAnchor ?? getPubAnchorLatLon(selectedPub);
    if (props.selectedSunBearingDeg !== undefined) {
      features.push(makeBearingFeature(selectedAnchor, props.selectedSunBearingDeg, 0.0012, "sun"));
    }
    if (props.selectedFrontBearingDeg !== undefined) {
      features.push(makeBearingFeature(selectedAnchor, props.selectedFrontBearingDeg, 0.00065, "front"));
    }

    source.setData({
      type: "FeatureCollection",
      features
    });
  }, [props.selectedAnchor, props.selectedFrontBearingDeg, props.selectedSunBearingDeg, selectedPub]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    ensureUserLocationImage(map);
    ensureUserLocationLayer(map);
    syncUserLocationSource(map, props.userLocation);
    if (!props.userLocation) return;
    map.easeTo({
      center: [props.userLocation.lon, props.userLocation.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 500
    });
  }, [props.userLocation, props.userRecenterTick]);

  return (
    <>
      <div ref={containerRef} className="map" />
      <div className="mapAttributionText" aria-hidden="true">
        © OpenStreetMap contributors © CARTO | MapLibre
      </div>
      {props.selectedPopover && popoverStyle ? (
        <div
          ref={popoverRef}
          className={`mapPinPopover ${popoverPlacement}`}
          style={{ left: `${popoverStyle.left}px`, top: `${popoverStyle.top}px` }}
        >
          {props.selectedPopover}
          <div className="mapPinPopoverArrow" aria-hidden="true" />
        </div>
      ) : null}
    </>
  );
}

function buildFeatureCollection(
  features: Array<GeoJSON.Feature<GeoJSON.Point, { id: string; icon: string; selected: number }>>
): GeoJSON.FeatureCollection<GeoJSON.Point, { id: string; icon: string; selected: number }> {
  return {
    type: "FeatureCollection",
    features
  };
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: []
  };
}

function ensureOverlayLayers(map: MapLibreMap) {
  if (!map.getSource("sun-guide")) {
    map.addSource("sun-guide", {
      type: "geojson",
      data: emptyFeatureCollection()
    });
  }
  if (!map.getLayer("sun-guide-line")) {
    map.addLayer({
      id: "sun-guide-line",
      type: "line",
      source: "sun-guide",
      paint: {
        "line-color": "#f6a90a",
        "line-width": 3,
        "line-opacity": 0.9
      },
      filter: ["==", ["get", "kind"], "sun"]
    });
  }
  if (!map.getLayer("front-guide-line")) {
    map.addLayer({
      id: "front-guide-line",
      type: "line",
      source: "sun-guide",
      paint: {
        "line-color": "#0b1020",
        "line-width": 2,
        "line-dasharray": [2, 2],
        "line-opacity": 0.65
      },
      filter: ["==", ["get", "kind"], "front"]
    });
  }
}

function registerPubPinInteractions(
  map: MapLibreMap,
  latestPropsRef: React.MutableRefObject<{
    pubs: Pub[];
    selectedPub?: Pub | null;
    selectedAnchor?: LatLon;
    selectedRecenterTick?: number;
    onSelect: (id: string) => void;
    onSelectUserLocation?: () => void;
    status: Map<string, "sunny" | "not" | "unknown">;
    userLocation?: { lat: number; lon: number } | null;
    selectedSunBearingDeg?: number;
    selectedFrontBearingDeg?: number;
  }>
) {
  const clickHandler = (event: maplibregl.MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
    const id = event.features?.[0]?.properties?.id;
    if (typeof id === "string") latestPropsRef.current.onSelect(id);
  };
  const enterHandler = () => {
    map.getCanvas().style.cursor = "pointer";
  };
  const leaveHandler = () => {
    map.getCanvas().style.cursor = "";
  };

  map.on("click", "pub-pins-layer", clickHandler);
  map.on("click", "selected-pub-pin-layer", clickHandler);
  map.on("click", "user-location-layer", () => {
    latestPropsRef.current.onSelectUserLocation?.();
  });
  map.on("mouseenter", "pub-pins-layer", enterHandler);
  map.on("mouseenter", "selected-pub-pin-layer", enterHandler);
  map.on("mouseenter", "user-location-layer", enterHandler);
  map.on("mouseleave", "pub-pins-layer", leaveHandler);
  map.on("mouseleave", "selected-pub-pin-layer", leaveHandler);
  map.on("mouseleave", "user-location-layer", leaveHandler);
}

function ensurePubPinLayers(map: MapLibreMap) {
  if (!map.getSource("pub-pins")) {
    map.addSource("pub-pins", {
      type: "geojson",
      data: emptyFeatureCollection()
    });
  }

  if (!map.getLayer("pub-pins-layer")) {
    map.addLayer({
      id: "pub-pins-layer",
      type: "symbol",
      source: "pub-pins",
      filter: ["==", ["get", "selected"], 0],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-anchor": "center",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
  }

  if (!map.getLayer("selected-pub-pin-layer")) {
    map.addLayer({
      id: "selected-pub-pin-layer",
      type: "symbol",
      source: "pub-pins",
      filter: ["==", ["get", "selected"], 1],
      layout: {
        "icon-image": ["get", "icon"],
        "icon-anchor": "center",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
  }
}

function ensureUserLocationLayer(map: MapLibreMap) {
  if (!map.getSource("user-location")) {
    map.addSource("user-location", {
      type: "geojson",
      data: emptyFeatureCollection()
    });
  }

  if (!map.getLayer("user-location-layer")) {
    map.addLayer({
      id: "user-location-layer",
      type: "symbol",
      source: "user-location",
      layout: {
        "icon-image": "user-location-pin-v3",
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
  }
}

function syncPubPinSource(
  map: MapLibreMap,
  data: GeoJSON.FeatureCollection<GeoJSON.Point, { id: string; icon: string; selected: number }>
) {
  const source = map.getSource("pub-pins") as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(data);
}

function syncUserLocationSource(map: MapLibreMap, userLocation?: { lat: number; lon: number } | null) {
  const source = map.getSource("user-location") as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    userLocation
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Point",
                coordinates: [userLocation.lon, userLocation.lat]
              }
            }
          ]
        }
      : emptyFeatureCollection()
  );
}

function ensurePubPinImages(map: MapLibreMap) {
  const variants: Array<{ status: "sunny" | "not" | "unknown"; selected: boolean }> = [
    { status: "sunny", selected: false },
    { status: "not", selected: false },
    { status: "unknown", selected: false },
    { status: "sunny", selected: true },
    { status: "not", selected: true },
    { status: "unknown", selected: true }
  ];

  for (const variant of variants) {
    const name = getPubPinIconName(variant.status, variant.selected);
    if (map.hasImage(name)) continue;
    map.addImage(name, createPinImage(variant), { pixelRatio: 2 });
  }
}

function ensureUserLocationImage(map: MapLibreMap) {
  if (map.hasImage("user-location-pin-v3")) return;
  map.addImage("user-location-pin-v3", createUserLocationPinImage(), { pixelRatio: 2 });
}

function getPubPinIconName(status: "sunny" | "not" | "unknown", selected: boolean) {
  return `pub-pin-v13-${selected ? "selected-" : ""}${status}`;
}

function createPinImage(params: { status: "sunny" | "not" | "unknown"; selected: boolean }) {
  const iconColor = params.status === "sunny" ? "#e7a31a" : "#74808f";
  const iconPx = params.selected ? 50 : 44;
  const padding = params.selected ? 12 : 10;
  const width = iconPx + padding * 2;
  const height = iconPx + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to create pin image");

  const centerX = width / 2;
  const centerY = height / 2;
  drawSportsBarGlyph(ctx, iconColor, centerX, centerY, iconPx, params.selected);

  return ctx.getImageData(0, 0, width, height);
}

function createUserLocationPinImage() {
  const size = 56;
  const paddingX = 8;
  const paddingTop = 8;
  const paddingBottom = 6;
  const width = size + paddingX * 2;
  const height = Math.round(size * (20 / 24) + paddingTop + paddingBottom);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to create user location pin image");

  const centerX = width / 2;
  const centerY = paddingTop + size / 2;
  drawLocationOnGlyph(ctx, "#d93025", centerX, centerY, size);

  return ctx.getImageData(0, 0, width, height);
}

function drawLocationOnGlyph(
  ctx: CanvasRenderingContext2D,
  color: string,
  centerX: number,
  centerY: number,
  size: number
) {
  ctx.save();
  ctx.translate(centerX, centerY);
  drawLocationOnPathGlyph(ctx, color, size);
  ctx.restore();
}

function drawLocationOnPathGlyph(ctx: CanvasRenderingContext2D, color: string, size: number) {
  const scale = size / 24;

  ctx.save();
  ctx.translate(-(12 * scale), -(12 * scale));
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";

  try {
    const glyphPath = new Path2D(materialIconPath("location_on"));
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = 2.2 / scale;
    ctx.stroke(glyphPath);
    ctx.fillStyle = color;
    ctx.fill(glyphPath);
  } catch {
    drawLocationOnFallbackGlyph(ctx, color, scale);
  }

  ctx.restore();
}

function drawLocationOnFallbackGlyph(ctx: CanvasRenderingContext2D, color: string, scale: number) {
  ctx.lineWidth = 2.2 / scale;
  ctx.strokeStyle = "rgba(255,255,255,0.96)";
  ctx.fillStyle = color;

  ctx.beginPath();
  ctx.moveTo(12, 2.2);
  ctx.bezierCurveTo(8.3, 2.2, 5.4, 5.2, 5.4, 8.9);
  ctx.bezierCurveTo(5.4, 13.8, 9.7, 18.6, 12, 21.1);
  ctx.bezierCurveTo(14.3, 18.6, 18.6, 13.8, 18.6, 8.9);
  ctx.bezierCurveTo(18.6, 5.2, 15.7, 2.2, 12, 2.2);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(12, 8.9, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.98)";
  ctx.fill();
}

function drawSportsBarGlyph(
  ctx: CanvasRenderingContext2D,
  color: string,
  centerX: number,
  centerY: number,
  size: number,
  selected: boolean
) {
  ctx.save();
  ctx.translate(centerX, centerY);
  drawMaterialPathGlyph(ctx, materialIconPath("sports_bar"), color, size, selected);
  ctx.restore();
}

function drawMaterialPathGlyph(
  ctx: CanvasRenderingContext2D,
  pathData: string,
  color: string,
  size: number,
  selected: boolean
) {
  const scale = size / 24;

  ctx.save();
  ctx.translate(-(12 * scale), -(12 * scale));
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";

  try {
    const glyphPath = new Path2D(pathData);
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = selected ? 2.6 / scale : 2.1 / scale;
    ctx.stroke(glyphPath);
    ctx.fillStyle = color;
    ctx.fill(glyphPath);
  } catch {
    drawSportsBarFallbackGlyph(ctx, color, selected, scale);
  }

  ctx.restore();
}

function drawSportsBarFallbackGlyph(
  ctx: CanvasRenderingContext2D,
  color: string,
  selected: boolean,
  scale: number
) {
  const strokeWidth = selected ? 2.6 / scale : 2.1 / scale;
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = "rgba(255,255,255,0.96)";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(5.5, 5.5);
  ctx.lineTo(18.5, 5.5);
  ctx.lineTo(15.2, 12);
  ctx.lineTo(8.8, 12);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();

  ctx.beginPath();
  ctx.rect(10.5, 12, 3, 6);
  ctx.stroke();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(7, 18);
  ctx.lineTo(17, 18);
  ctx.quadraticCurveTo(18, 18, 18, 19);
  ctx.quadraticCurveTo(18, 20.5, 17, 20.5);
  ctx.lineTo(7, 20.5);
  ctx.quadraticCurveTo(6, 20.5, 6, 19);
  ctx.quadraticCurveTo(6, 18, 7, 18);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}

function getPubAnchorLatLon(pub: Pub): LatLon {
  return {
    lat: pub.displayLat ?? pub.lat,
    lon: pub.displayLon ?? pub.lon
  };
}

function makeBearingFeature(anchor: LatLon, bearingDeg: number, distanceDeg: number, kind: "sun" | "front"): GeoJSON.Feature {
  const rad = (bearingDeg * Math.PI) / 180;
  const latDelta = Math.cos(rad) * distanceDeg;
  const lonDelta = (Math.sin(rad) * distanceDeg) / Math.cos((anchor.lat * Math.PI) / 180);
  return {
    type: "Feature",
    properties: { kind },
    geometry: {
      type: "LineString",
      coordinates: [
        [anchor.lon, anchor.lat],
        [anchor.lon + lonDelta, anchor.lat + latDelta]
      ]
    }
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
