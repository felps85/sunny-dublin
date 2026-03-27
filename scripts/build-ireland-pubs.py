#!/usr/bin/env python3
import json
import math
import re
import sqlite3
import struct
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GPKG_PATH = Path("/tmp/ireland-and-northern-ireland.gpkg")
DEFAULT_OUT_PATH = ROOT / "public" / "pubs-ireland-lite.json"
CURRENT_PUBS_PATH = ROOT / "public" / "pubs.json"
CURATED_PUBS_PATH = ROOT / "scripts" / "curated-pubs.json"


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    normalized = normalized.lower().replace("’", "").replace("'", "").replace("&", " and ")
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return normalized


def haversine_distance_m(a: dict, b: dict) -> float:
    radius_m = 6371000
    lat1 = math.radians(a["lat"])
    lat2 = math.radians(b["lat"])
    d_lat = math.radians(b["lat"] - a["lat"])
    d_lon = math.radians(b["lon"] - a["lon"])
    x = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    return radius_m * 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def decode_gpkg_point(blob: bytes):
    if not blob or len(blob) < 29 or blob[:2] != b"GP":
      return None

    flags = blob[3]
    envelope_indicator = (flags >> 1) & 0b111
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    header_size = 8 + envelope_sizes.get(envelope_indicator, 0)
    wkb = blob[header_size:]
    if len(wkb) < 21:
        return None

    byte_order = wkb[0]
    endian = "<" if byte_order == 1 else ">"
    geom_type = struct.unpack(f"{endian}I", wkb[1:5])[0]
    if geom_type != 1:
        return None

    lon, lat = struct.unpack(f"{endian}dd", wkb[5:21])
    return {"lat": lat, "lon": lon}


def load_json_list(path: Path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    return raw if isinstance(raw, list) else []


def enrich_from_existing(base_pub: dict, existing_by_name: dict):
    candidates = existing_by_name.get(normalize_name(base_pub["name"]), [])
    best = None
    best_distance = None

    for candidate in candidates:
        distance = haversine_distance_m(base_pub, candidate)
        if distance > 160:
            continue
        if best is None or distance < best_distance:
            best = candidate
            best_distance = distance

    if not best:
        return base_pub

    enriched = dict(base_pub)
    for key in ("displayLat", "displayLon", "frontBearingDeg", "shadeClearanceDeg"):
        if key in best and best[key] is not None:
            enriched[key] = best[key]
    return enriched


def main():
    gpkg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_GPKG_PATH
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT_PATH

    if not gpkg_path.exists():
        raise SystemExit(f"GeoPackage not found: {gpkg_path}")

    existing_pubs = load_json_list(CURRENT_PUBS_PATH)
    curated_pubs = load_json_list(CURATED_PUBS_PATH)

    existing_by_name = defaultdict(list)
    for row in existing_pubs:
        if isinstance(row, dict) and isinstance(row.get("name"), str):
            existing_by_name[normalize_name(row["name"])].append(row)

    pubs = []
    seen = set()
    connection = sqlite3.connect(str(gpkg_path))
    cursor = connection.execute(
        """
        SELECT osm_id, fclass, name, geom
        FROM gis_osm_pois_free
        WHERE fclass IN ('pub', 'bar')
          AND name IS NOT NULL
          AND TRIM(name) <> ''
        """
    )

    for osm_id, fclass, name, geom in cursor:
        point = decode_gpkg_point(geom)
        if point is None:
            continue

        pub = {
            "id": f"{normalize_name(name)}-geofabrik-{osm_id}",
            "name": name,
            "lat": round(point["lat"], 7),
            "lon": round(point["lon"], 7),
            "displayLat": round(point["lat"], 7),
            "displayLon": round(point["lon"], 7),
        }
        enriched = enrich_from_existing(pub, existing_by_name)

        dedupe_key = (normalize_name(enriched["name"]), round(enriched["lat"], 4), round(enriched["lon"], 4))
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        pubs.append(enriched)

    connection.close()

    for curated in curated_pubs:
        if not isinstance(curated, dict):
            continue
        name = curated.get("name")
        lat = curated.get("lat")
        lon = curated.get("lon")
        if not isinstance(name, str) or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue

        candidate = {
            "id": curated.get("id") if isinstance(curated.get("id"), str) else f"{normalize_name(name)}-curated",
            "name": name,
            "lat": float(lat),
            "lon": float(lon),
            "displayLat": float(curated.get("displayLat", lat)),
            "displayLon": float(curated.get("displayLon", lon)),
        }
        for key in ("frontBearingDeg", "shadeClearanceDeg"):
            if isinstance(curated.get(key), (int, float)):
                candidate[key] = float(curated[key])

        key = normalize_name(candidate["name"])
        duplicate = any(
            normalize_name(existing["name"]) == key and haversine_distance_m(candidate, existing) <= 160 for existing in pubs
        )
        if not duplicate:
            pubs.append(candidate)

    pubs.sort(key=lambda pub: unicodedata.normalize("NFKD", pub["name"]).casefold())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(pubs, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(f"Wrote {len(pubs)} pubs to {out_path}")


if __name__ == "__main__":
    main()
