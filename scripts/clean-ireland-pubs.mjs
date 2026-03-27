import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const FULL_PATH = path.join(root, "public", "pubs-ireland.json");
const LITE_PATH = path.join(root, "public", "pubs-ireland-lite.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeName(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function haversineDistanceM(a, b) {
  const radiusM = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radiusM * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function isNumericOnlyVenueName(name) {
  return /^\d+[A-Za-z]?$/.test((name || "").trim());
}

function isValidPub(pub) {
  return (
    pub &&
    typeof pub === "object" &&
    typeof pub.id === "string" &&
    typeof pub.name === "string" &&
    typeof pub.lat === "number" &&
    typeof pub.lon === "number" &&
    !isNumericOnlyVenueName(pub.name)
  );
}

function cleanDataset(rows) {
  const deduped = [];
  const seenIds = new Set();
  const seenNameLocation = new Set();

  for (const row of rows) {
    if (!isValidPub(row)) continue;
    if (seenIds.has(row.id)) continue;

    const key = `${normalizeName(row.name)}:${row.lat.toFixed(4)}:${row.lon.toFixed(4)}`;
    if (seenNameLocation.has(key)) continue;

    seenIds.add(row.id);
    seenNameLocation.add(key);
    deduped.push(row);
  }

  deduped.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
  );

  return deduped;
}

function mergeMissingFallbackPubs(primary, fallback) {
  const merged = [...primary];

  for (const candidate of fallback) {
    if (!isValidPub(candidate)) continue;
    const duplicate = merged.some(
      (existing) =>
        normalizeName(existing.name) === normalizeName(candidate.name) &&
        haversineDistanceM(existing, candidate) <= 160
    );
    if (!duplicate) merged.push(candidate);
  }

  return cleanDataset(merged);
}

const full = cleanDataset(readJson(FULL_PATH));
const lite = cleanDataset(readJson(LITE_PATH));
const mergedFull = mergeMissingFallbackPubs(full, lite);
const cleanedLite = cleanDataset(lite);

writeJson(FULL_PATH, mergedFull);
writeJson(LITE_PATH, cleanedLite);

console.log(
  JSON.stringify(
    {
      fullCount: mergedFull.length,
      liteCount: cleanedLite.length
    },
    null,
    2
  )
);
